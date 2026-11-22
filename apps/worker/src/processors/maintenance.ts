import { clock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import { enqueue, type JobContext } from '@orbit/queue';
import { sweepAccountHealth } from '../health/sweep.js';
import { sweepAnalytics } from '../analytics/sweep.js';
import { sweepComments } from '../engagement/sweep.js';
import { sweepConversations } from '../messaging/sweep.js';
import { sweepWebhookEvents } from '../messaging/webhooks.js';
import { sweepRetention } from '../maintenance/retention.js';
import { drainEmailOutbox } from '../notifications/outbox.js';
import { mailer } from '../notifications/mailer.js';

/**
 * Housekeeping (SRS §13, §40).
 *
 * The one queue that is **not** tenant-scoped: it sweeps the whole platform, so
 * it uses `platformDb` directly and every task here is written to be safe to
 * run twice. It is deliberately the only place in the worker that reads
 * unscoped, and it never touches post content — only lifecycle state.
 *
 * `reconcile-stuck-jobs` is the one that matters for T1.13: a worker killed
 * mid-publish leaves a `PostVariant` in `PUBLISHING` with a claim token and no
 * live job. Left alone it would sit there forever, because nothing else clears
 * a claim. This finds them and hands each back to the publish queue — it does
 * **not** republish and does not clear the claim itself. The engine takes the
 * aged-out claim over and reconciles with the platform first (layer 4): found
 * is published, not found is published or — hours late — left for a person,
 * and unknown is left for a person.
 */

/** How long a claim may be held before it is considered abandoned. */
const STUCK_CLAIM_MS = 15 * 60 * 1_000;

/** Staged OAuth accounts that were never confirmed (T1.6). */
const STAGED_ACCOUNT_TTL_MS = 60 * 60 * 1_000;

export async function processMaintenance({ payload }: JobContext<'maintenance'>): Promise<void> {
  switch (payload.task) {
    case 'reconcile-stuck-jobs':
      await reconcileStuckJobs(payload.correlationId);
      return;
    case 'cleanup-staged-accounts':
      await cleanupStagedAccounts();
      return;
    case 'drain-email-outbox':
      // The notification row is the outbox; this is the only thing that sends.
      // Kept out of the notifications processor deliberately — a mail API call
      // inside the fan-out transaction would be a third-party HTTP request in
      // the slowest possible place, and a timeout would roll back notifications
      // that ought to exist.
      // The factory, not the instance: a missing RESEND_API_KEY must not fail
      // this job when there is no mail to send.
      await drainEmailOutbox(mailer);
      return;
    case 'sweep-account-health':
      // Queues the probes; it does not perform them. The provider calls run on
      // the `account-health` queue, so a slow platform cannot stall housekeeping.
      await sweepAccountHealth(payload.correlationId);
      return;
    case 'analytics-rollup':
      // Queues the pulls; it does not perform them. The provider calls run on
      // the `analytics` queue, so a slow platform cannot stall housekeeping —
      // the same split as the health sweep, and for the same reason.
      await sweepAnalytics(payload.correlationId);
      return;
    case 'sweep-comments':
      // Same split again: this queues the reads, and the provider calls run on
      // the `engagement` queue. Its cadence is far faster than the analytics
      // one — a stale metric is an old number, a stale comment is a customer
      // who has been waiting.
      await sweepComments(payload.correlationId);
      return;
    case 'sweep-webhook-events':
      // Webhook events are stored before they are queued, so one whose enqueue
      // failed waits in the database rather than being lost (D-107).
      await sweepWebhookEvents(payload.correlationId);
      return;
    case 'sweep-conversations':
      // Queues the backfill reads; the provider calls run on `messaging`, the
      // same split as every other sweep here (D-107).
      await sweepConversations(payload.correlationId);
      return;
    case 'retention':
      // The one task that deletes data nobody asked to delete. It is scoped per
      // tenant, batched, and rounds every boundary in the direction of keeping
      // things — see the module for what it will and will not touch.
      await sweepRetention(payload.correlationId);
      return;
    default: {
      const exhaustive: never = payload.task;
      throw new Error(`Unhandled maintenance task: ${String(exhaustive)}`);
    }
  }
}

/**
 * Find publishes that were claimed and never finished, and queue them to be
 * reconciled.
 *
 * A variant stuck in `PUBLISHING` may or may not have reached the platform,
 * and guessing is exactly what the idempotency design forbids
 * (docs/ARCHITECTURE.md §5.2) — so this decides nothing. It only gives each one
 * a publish job again; the engine finds the claim aged out, takes it over and
 * asks the platform before anything else. Until 2026-11-22 this only logged,
 * and eleven variants sat in `PUBLISHING` for up to two days.
 *
 * One job per stuck claim: the job id names the variant and the claim's time,
 * so a sweep every few minutes does not stack them, and a claim that is taken
 * over and stuck again gets a new one.
 */
export async function reconcileStuckJobs(correlationId: string): Promise<void> {
  const cutoff = new Date(clock.now().getTime() - STUCK_CLAIM_MS);

  const stuck = await platformDb.postVariant.findMany({
    where: { status: 'PUBLISHING', claimedAt: { lt: cutoff } },
    select: {
      id: true,
      organizationId: true,
      socialAccountId: true,
      claimedAt: true,
      claimToken: true,
    },
    take: 200,
  });

  if (stuck.length === 0) return;

  let queued = 0;
  const unqueued: string[] = [];
  for (const variant of stuck) {
    const job = await platformDb.publishingJob.findFirst({
      where: { postVariantId: variant.id, organizationId: variant.organizationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, idempotencyKey: true },
    });
    if (!job || !variant.claimedAt) {
      unqueued.push(variant.id);
      continue;
    }

    try {
      await enqueue(
        'publish',
        {
          organizationId: variant.organizationId,
          correlationId,
          postVariantId: variant.id,
          idempotencyKey: job.idempotencyKey,
          publishingJobId: job.id,
        },
        { jobId: `recover-${variant.id}-${variant.claimedAt.getTime()}` },
      );
      queued += 1;
    } catch (error) {
      unqueued.push(variant.id);
      logger.error('could not queue a stuck publish for reconciliation', {
        variantId: variant.id,
        organizationId: variant.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.error('publishes claimed but never finished', {
    count: stuck.length,
    // Ids only. A claim token is a capability of sorts, so it is not logged.
    variantIds: stuck.map((v) => v.id),
    queued,
    ...(unqueued.length > 0 ? { unqueued } : {}),
    note: 'queued for reconciliation with the platform before any retry',
  });
}

/**
 * Delete OAuth accounts staged but never confirmed.
 *
 * T1.6 writes discovered Pages as `DISABLED` rows so credentials survive
 * between the token exchange and the user's choice of which to connect. An
 * abandoned flow leaves encrypted credentials sitting there, so they are swept.
 *
 * Aged by `updatedAt`, not `connectedAt`: staging a disconnected account
 * revives its old row, whose `connectedAt` is months old, and judging it by
 * that swept it while the person was still choosing.
 *
 * A row with history — published variants or analytics — is returned to the
 * disconnected state rather than deleted, the same rule as
 * `discardStagedAccounts` on the web side: deleting it would cascade through
 * the posts that went out on it.
 */
async function cleanupStagedAccounts(): Promise<void> {
  const cutoff = new Date(clock.now().getTime() - STAGED_ACCOUNT_TTL_MS);
  const abandoned = { status: 'DISABLED' as const, updatedAt: { lt: cutoff } };

  const { count } = await platformDb.socialAccount.deleteMany({
    where: { ...abandoned, variants: { none: {} }, snapshots: { none: {} } },
  });

  const withHistory = await platformDb.socialAccount.findMany({
    where: abandoned,
    select: { id: true },
    take: 500,
  });
  const ids = withHistory.map((row) => row.id);
  if (ids.length > 0) {
    // Status first, guarded, so a row somebody connects in this instant keeps
    // its credential: only rows this sweep actually returned lose theirs.
    await platformDb.socialAccount.updateMany({
      where: { id: { in: ids }, status: 'DISABLED' },
      data: { status: 'REVOKED', deletedAt: clock.now() },
    });
    await platformDb.socialCredential.deleteMany({
      where: { socialAccountId: { in: ids }, socialAccount: { status: 'REVOKED' } },
    });
  }

  if (count > 0 || ids.length > 0) {
    logger.info('swept abandoned staged accounts', { count, keptForHistory: ids.length });
  }
}
