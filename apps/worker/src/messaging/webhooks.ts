import { MESSAGING_WORKER_CAPABILITIES } from '@orbit/auth';
import { clock, type Platform } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import type { ProviderEvent } from '@orbit/providers';
import { enqueue } from '@orbit/queue';
import { resolveTenantForJob } from '../context.js';
import { ingestMessageEvent } from './ingest.js';

/**
 * Turning a stored webhook event into rows (**D-107**).
 *
 * The web route verified the signature, stored each event it parsed, and
 * answered Meta at once. This is the slow half, run here so that a worker
 * outage delays an inbox rather than losing it: the events wait in the
 * database, and `sweepWebhookEvents` hands any that were never processed back
 * to the queue.
 *
 * ## One delivery, several tenants
 *
 * A webhook names an account by the platform's id, and two agencies may have
 * the same Page connected. Each matching account is resolved to its own tenant
 * and written separately — the event belongs to all of them, and to none of
 * them more than the others.
 *
 * ## What is kept afterwards
 *
 * Nothing private. `WebhookEvent` is platform-wide, without the row-level
 * security every tenant table has, so once a message has been written to its
 * tenant's tables the stored copy is reduced to its kind. The deduplication
 * key stays, which is all the row is needed for.
 */

export interface WebhookEventResult {
  accounts: number;
  recorded: number;
  commentsQueued: number;
  /** Why matched accounts wrote nothing, e.g. messaging off on this worker. */
  skipped: string[];
}

export async function processWebhookEvent(input: {
  webhookEventId: string;
  jobId: string;
  correlationId: string;
}): Promise<WebhookEventResult> {
  const { webhookEventId, correlationId } = input;
  const result: WebhookEventResult = {
    accounts: 0,
    recorded: 0,
    commentsQueued: 0,
    skipped: [],
  };

  const row = await platformDb.webhookEvent.findUnique({
    where: { id: webhookEventId },
    select: { id: true, provider: true, payload: true, processedAt: true },
  });

  // Gone or done: a retry of a job that already finished.
  if (!row || row.processedAt) return result;

  const platform = row.provider as Platform;
  const event = reviveEvent(row.payload);

  try {
    if (event?.kind === 'MESSAGE') {
      const accounts = await accountsNamed(platform, event.accountExternalId);
      result.accounts = accounts.length;

      for (const account of accounts) {
        const { ctx } = await resolveTenantForJob({
          queue: 'webhooks',
          jobId: input.jobId,
          claimedOrganizationId: account.organizationId,
          subject: { subjectType: 'socialAccount', subjectId: account.id },
          actorName: 'messaging-worker',
          capabilities: MESSAGING_WORKER_CAPABILITIES,
          correlationId,
        });

        const ingested = await ingestMessageEvent({
          ctx,
          socialAccountId: account.id,
          message: event.message,
          deleted: event.deleted,
        });
        if (ingested.kind === 'RECORDED' && ingested.recorded.created) result.recorded += 1;
        if (ingested.kind === 'SKIPPED') result.skipped.push(ingested.reason);
      }
    } else if (event?.kind === 'COMMENT_ACTIVITY') {
      result.commentsQueued = await queueCommentRead(platform, event.externalPostId, correlationId);
    }

    await platformDb.webhookEvent.update({
      where: { id: row.id },
      data: {
        processedAt: clock.now(),
        error: null,
        // The message has reached its tenant; the platform-wide copy goes.
        payload: { kind: event?.kind ?? 'UNKNOWN', scrubbed: true },
      },
    });
  } catch (error) {
    await platformDb.webhookEvent.update({
      where: { id: row.id },
      data: { error: (error instanceof Error ? error.message : String(error)).slice(0, 500) },
    });
    throw error;
  }

  if (result.accounts === 0 && event?.kind === 'MESSAGE') {
    // A Page connected nowhere, or disconnected since. Not an error: Meta
    // keeps delivering to an app until the subscription is removed.
    logger.info('webhook message for an account no organization has connected', {
      webhookEventId,
      platform,
    });
  }

  // A message that reached a connected account and was still not written is
  // the one case somebody needs to see: it is what "I messaged the Page and
  // nothing appeared" looks like from here. UNSUPPORTED means this worker has
  // messaging switched off (META_MESSAGING_ENABLED). Nothing private is
  // logged — the reason, not the message.
  if (result.skipped.length > 0) {
    logger.warn('webhook message reached a connected account but was not recorded', {
      webhookEventId,
      platform,
      reasons: [...new Set(result.skipped)],
    });
  }

  return result;
}

/**
 * Every live connection of this platform account, in any organization.
 *
 * Matched on either id, because Instagram's username login delivers webhooks
 * under an id that is not the one the connect flow stored (D-107).
 */
async function accountsNamed(platform: Platform, externalId: string) {
  return platformDb.socialAccount.findMany({
    where: {
      platform,
      deletedAt: null,
      status: { in: ['ACTIVE', 'NEEDS_RECONNECT'] },
      OR: [{ externalId }, { webhookExternalId: externalId }],
    },
    select: { id: true, organizationId: true },
    take: 50,
  });
}

/**
 * A comment arrived: read the post's comments now, through the one ingestion
 * path that writes comments.
 *
 * The job id is bucketed by minute, so a post receiving fifty comments in a
 * burst is read once or twice rather than fifty times.
 */
async function queueCommentRead(
  platform: Platform,
  externalPostId: string,
  correlationId: string,
): Promise<number> {
  const variants = await platformDb.postVariant.findMany({
    where: {
      platform,
      externalPostId,
      status: 'PUBLISHED',
      deletedAt: null,
      socialAccount: { deletedAt: null, status: { in: ['ACTIVE', 'NEEDS_RECONNECT'] } },
    },
    select: { id: true, organizationId: true, socialAccountId: true },
    take: 20,
  });

  const minute = Math.floor(clock.now().getTime() / 60_000);

  for (const variant of variants) {
    await enqueue(
      'engagement',
      {
        organizationId: variant.organizationId,
        correlationId,
        socialAccountId: variant.socialAccountId,
        postVariantId: variant.id,
      },
      { jobId: `comments-hook-${variant.id}-${minute}` },
    );
  }

  return variants.length;
}

/**
 * The stored event, with its dates back as dates.
 *
 * It went into a JSON column, so `sentAt` and `occurredAt` come back as
 * strings. Anything that does not look like an event the route could have
 * written is treated as nothing, and the row is closed rather than retried
 * forever.
 */
function reviveEvent(payload: unknown): ProviderEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;

  if (raw.kind === 'MESSAGE' && raw.message && typeof raw.accountExternalId === 'string') {
    const message = raw.message as Record<string, unknown>;
    if (
      typeof message.externalId !== 'string' ||
      typeof message.participantExternalId !== 'string' ||
      (message.direction !== 'INBOUND' && message.direction !== 'OUTBOUND')
    ) {
      return null;
    }

    return {
      kind: 'MESSAGE',
      externalEventId: String(raw.externalEventId ?? ''),
      accountExternalId: raw.accountExternalId,
      ...(raw.deleted === true ? { deleted: true } : {}),
      message: {
        externalId: message.externalId,
        participantExternalId: message.participantExternalId,
        direction: message.direction,
        ...(typeof message.text === 'string' ? { text: message.text } : {}),
        attachments: Array.isArray(message.attachments)
          ? (message.attachments as Array<{ type?: unknown; url?: unknown }>)
              .filter((attachment) => typeof attachment.type === 'string')
              .map((attachment) => ({
                type: attachment.type as string,
                ...(typeof attachment.url === 'string' ? { url: attachment.url } : {}),
              }))
          : [],
        sentAt: new Date(String(message.sentAt)),
      },
    };
  }

  if (
    raw.kind === 'COMMENT_ACTIVITY' &&
    typeof raw.accountExternalId === 'string' &&
    typeof raw.externalPostId === 'string'
  ) {
    return {
      kind: 'COMMENT_ACTIVITY',
      externalEventId: String(raw.externalEventId ?? ''),
      accountExternalId: raw.accountExternalId,
      externalPostId: raw.externalPostId,
      occurredAt: new Date(String(raw.occurredAt)),
    };
  }

  return null;
}

// ── Sweeps ──────────────────────────────────────────────────────────────────

/** An event younger than this is probably still in the queue. */
const UNPROCESSED_GRACE_MS = 2 * 60 * 1_000;
/** Processed rows are kept this long, for deduplicating late retries. */
const PROCESSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/**
 * An event still failing after this is given up on, loudly. Past the reply
 * window it could no longer help anybody, and retrying it forever would only
 * bury the next real failure in the same log line.
 */
const ABANDON_AFTER_MS = 48 * 60 * 60 * 1_000;
/** Requeue at most this often per event, so a failing one is not hammered. */
const REQUEUE_BUCKET_MS = 10 * 60 * 1_000;
const SWEEP_BATCH = 200;

/**
 * Hand back events nobody processed, and forget old processed ones.
 *
 * An event is stored before it is enqueued, so a failed enqueue — Redis down,
 * a deploy at the wrong moment — leaves it waiting here instead of lost. Meta
 * retries for thirty-six hours, but only deliveries we did not acknowledge;
 * everything we acknowledged is ours to finish.
 */
export async function sweepWebhookEvents(correlationId: string): Promise<{
  requeued: number;
  abandoned: number;
  forgotten: number;
}> {
  const now = clock.now().getTime();

  const { count: abandoned } = await platformDb.webhookEvent.updateMany({
    where: { processedAt: null, createdAt: { lt: new Date(now - ABANDON_AFTER_MS) } },
    data: {
      processedAt: new Date(now),
      error: 'abandoned: still failing after 48 hours',
      payload: { kind: 'ABANDONED', scrubbed: true },
    },
  });
  if (abandoned > 0) {
    logger.error('gave up on webhook events that never processed', { abandoned });
  }

  const waiting = await platformDb.webhookEvent.findMany({
    where: { processedAt: null, createdAt: { lt: new Date(now - UNPROCESSED_GRACE_MS) } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: SWEEP_BATCH,
  });

  let requeued = 0;
  for (const event of waiting) {
    try {
      await enqueue(
        'webhooks',
        { correlationId, webhookEventId: event.id },
        // Not the route's id: BullMQ drops an add whose id matches a job it
        // still holds, and a job that failed every attempt is still held — so
        // reusing the id would never retry it. Bucketed so the same event is
        // requeued at most every ten minutes; processing is idempotent if an
        // earlier job is somehow still running.
        { jobId: `webhook-${event.id}-${Math.floor(now / REQUEUE_BUCKET_MS)}` },
      );
      requeued += 1;
    } catch (error) {
      logger.error('failed to requeue a stored webhook event', {
        webhookEventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const { count: forgotten } = await platformDb.webhookEvent.deleteMany({
    where: { processedAt: { lt: new Date(now - PROCESSED_RETENTION_MS) } },
  });

  if (requeued > 0) logger.warn('requeued unprocessed webhook events', { requeued });

  return { requeued, abandoned, forgotten };
}
