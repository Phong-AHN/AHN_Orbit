import { clock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import { enqueue } from '@orbit/queue';

/**
 * The analytics sweep (T3.2, SRS §18).
 *
 * Finds what is due a refresh and queues one job each. Like the health sweep it
 * runs on `maintenance` and does no provider work itself — the calls happen on
 * the `analytics` queue at concurrency 3, so a slow platform cannot stall
 * housekeeping. It reads unscoped for the same reason: "what is stale" is a
 * platform-wide question, and every row carries its own `organizationId` for
 * the processor to derive its tenant from (**D-021**).
 *
 * ## The cadence, and why it is shaped this way
 *
 * Meta's rate limit is **per app**, not per account, so every poll one agency
 * makes is quota another agency's publish cannot use. That is the constraint
 * the whole schedule is built around, and it is why nothing here polls hourly:
 *
 * | What | How often | Why |
 * |---|---|---|
 * | Posts younger than 7 days | every 6h | Where the movement is; a client asks about this week's post, not last quarter's |
 * | Posts 7 days or older | daily | The numbers have mostly settled; a finer poll buys noise |
 * | Account totals | daily | A day-bucket figure, so more than once a day only refines the open day |
 * | Backfill on connect | 30 days | Enough for a first report to have shape without a burst of hundreds of calls at connect time |
 *
 * Retention is 13 months — a year plus a month, so a same-period-last-year
 * comparison always has its comparator.
 */

/** Posts younger than this refresh on the fast cadence. */
export const FRESH_POST_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/** The two post cadences. */
export const FRESH_POST_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const MATURE_POST_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** Account-level figures are a day bucket, so once a day. */
export const ACCOUNT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/** How far back a newly connected account is backfilled. */
export const BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

/** Snapshots older than this are swept by the retention task. */
export const ANALYTICS_RETENTION_MS = 13 * 30 * 24 * 60 * 60 * 1_000;

/** How many of each kind one pass will queue. A backlog drains over later passes. */
const SWEEP_BATCH = 300;

export interface AnalyticsSweepResult {
  posts: number;
  accounts: number;
  failed: number;
}

export async function sweepAnalytics(correlationId: string): Promise<AnalyticsSweepResult> {
  const now = clock.now();
  const result: AnalyticsSweepResult = { posts: 0, accounts: 0, failed: 0 };

  await sweepPosts(now, correlationId, result);
  await sweepAccounts(now, correlationId, result);

  if (result.posts > 0 || result.accounts > 0 || result.failed > 0) {
    logger.info('analytics sweep complete', { ...result });
  }

  return result;
}

/**
 * Published variants whose last capture is older than their cadence allows.
 *
 * The age test and the staleness test are both on the *variant*, which is why
 * this is one query rather than two: a post's age decides which interval
 * applies, and the newest `PostAnalytics` row decides whether that interval has
 * elapsed. A variant with no analytics at all is due immediately — that is the
 * backfill, and it needs no separate path.
 */
async function sweepPosts(
  now: Date,
  correlationId: string,
  result: AnalyticsSweepResult,
): Promise<void> {
  const freshFrom = new Date(now.getTime() - FRESH_POST_AGE_MS);
  const backfillFrom = new Date(now.getTime() - BACKFILL_WINDOW_MS);
  const freshCutoff = new Date(now.getTime() - FRESH_POST_INTERVAL_MS);
  const matureCutoff = new Date(now.getTime() - MATURE_POST_INTERVAL_MS);

  const candidates = await platformDb.postVariant.findMany({
    where: {
      deletedAt: null,
      status: 'PUBLISHED',
      externalPostId: { not: null },
      // Older than the backfill window is out of scope entirely. Without this
      // every account's whole history would be due on the first sweep.
      publishedAt: { gte: backfillFrom },
      socialAccount: { deletedAt: null, status: { in: ['ACTIVE', 'NEEDS_RECONNECT'] } },
    },
    select: {
      id: true,
      organizationId: true,
      socialAccountId: true,
      publishedAt: true,
      analytics: {
        select: { capturedAt: true },
        orderBy: { capturedAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { publishedAt: 'desc' },
    take: SWEEP_BATCH * 3,
  });

  const due = candidates.filter((variant) => {
    const publishedAt = variant.publishedAt;
    if (!publishedAt) return false;

    const lastCapture = variant.analytics[0]?.capturedAt;
    if (!lastCapture) return true;

    const cutoff = publishedAt >= freshFrom ? freshCutoff : matureCutoff;
    return lastCapture < cutoff;
  });

  for (const variant of due.slice(0, SWEEP_BATCH)) {
    // One id per variant per interval bucket, so two workers sweeping at the
    // same moment produce one job rather than two. BullMQ drops the duplicate.
    //
    // Hyphens, not colons. BullMQ rejects a custom id containing `:` unless it
    // splits into exactly three parts — a back-compat carve-out for its own old
    // repeatable ids — and its source marks that carve-out for removal in the
    // next breaking change. Avoiding the character entirely costs nothing and
    // survives that.
    const interval =
      variant.publishedAt && variant.publishedAt >= freshFrom
        ? FRESH_POST_INTERVAL_MS
        : MATURE_POST_INTERVAL_MS;
    const window = Math.floor(now.getTime() / interval);

    try {
      await enqueue(
        'analytics',
        {
          organizationId: variant.organizationId,
          correlationId,
          socialAccountId: variant.socialAccountId,
          postVariantId: variant.id,
        },
        { jobId: `analytics-post-${variant.id}-${window}` },
      );

      result.posts += 1;
    } catch (error) {
      // One bad variant must not abandon the rest of the sweep.
      result.failed += 1;
      logger.error('failed to enqueue post analytics', {
        postVariantId: variant.id,
        organizationId: variant.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Connected accounts whose day bucket has not been written today. */
async function sweepAccounts(
  now: Date,
  correlationId: string,
  result: AnalyticsSweepResult,
): Promise<void> {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );

  const accounts = await platformDb.socialAccount.findMany({
    where: {
      deletedAt: null,
      // NEEDS_RECONNECT is excluded here, unlike the health sweep: a broken
      // token cannot answer an insights call, and re-asking is quota spent to
      // rediscover something health already knows.
      status: 'ACTIVE',
      snapshots: { none: { date: today } },
    },
    select: { id: true, organizationId: true },
    take: SWEEP_BATCH,
  });

  const window = Math.floor(now.getTime() / ACCOUNT_INTERVAL_MS);

  for (const account of accounts) {
    try {
      await enqueue(
        'analytics',
        {
          organizationId: account.organizationId,
          correlationId,
          socialAccountId: account.id,
        },
        { jobId: `analytics-account-${account.id}-${window}` },
      );

      result.accounts += 1;
    } catch (error) {
      result.failed += 1;
      logger.error('failed to enqueue account analytics', {
        socialAccountId: account.id,
        organizationId: account.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
