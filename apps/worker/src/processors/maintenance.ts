import { clock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import type { JobContext } from '@orbit/queue';
import { sweepAccountHealth } from '../health/sweep.js';
import { sweepAnalytics } from '../analytics/sweep.js';
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
 * a claim. This finds them and flags them — it does **not** republish, and it
 * does not clear the claim, because the outcome is ambiguous and the
 * publishing engine's reconciliation (layer 4) is what decides.
 */

/** How long a claim may be held before it is considered abandoned. */
const STUCK_CLAIM_MS = 15 * 60 * 1_000;

/** Staged OAuth accounts that were never confirmed (T1.6). */
const STAGED_ACCOUNT_TTL_MS = 60 * 60 * 1_000;

export async function processMaintenance({ payload }: JobContext<'maintenance'>): Promise<void> {
  switch (payload.task) {
    case 'reconcile-stuck-jobs':
      await reconcileStuckJobs();
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
      await drainEmailOutbox(mailer());
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
 * Find publishes that were claimed and never finished.
 *
 * Reports them; does not resolve them. A variant stuck in `PUBLISHING` may or
 * may not have reached the platform, and guessing is exactly what the
 * idempotency design forbids (docs/ARCHITECTURE.md §5.2). T1.13 adds the
 * reconciliation call; until then this makes the condition visible rather than
 * silent.
 */
async function reconcileStuckJobs(): Promise<void> {
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

  logger.error('publishes claimed but never finished', {
    count: stuck.length,
    // Ids only. A claim token is a capability of sorts, so it is not logged.
    variantIds: stuck.map((v) => v.id),
    note: 'awaiting provider reconciliation before any retry',
  });
}

/**
 * Delete OAuth accounts staged but never confirmed.
 *
 * T1.6 writes discovered Pages as `DISABLED` rows so credentials survive
 * between the token exchange and the user's choice of which to connect. An
 * abandoned flow leaves encrypted credentials sitting there, so they are swept.
 */
async function cleanupStagedAccounts(): Promise<void> {
  const cutoff = new Date(clock.now().getTime() - STAGED_ACCOUNT_TTL_MS);

  const { count } = await platformDb.socialAccount.deleteMany({
    where: { status: 'DISABLED', connectedAt: { lt: cutoff }, variants: { none: {} } },
  });

  if (count > 0) {
    logger.info('swept abandoned staged accounts', { count });
  }
}
