import { clock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import { enqueue } from '@orbit/queue';

/**
 * The comment sweep (SRS §22).
 *
 * Finds published posts whose comments are due a read and queues one job each.
 * Shaped like the analytics sweep and for the same reasons: it runs on
 * `maintenance`, does no provider work itself, and reads unscoped because "what
 * is stale" is a platform-wide question while every row carries its own
 * `organizationId` for the processor to derive its tenant from (**D-021**).
 *
 * ## The cadence is faster than analytics, and that is the point
 *
 * Meta's rate limit is per app, so every poll one agency makes is quota another
 * agency's publish cannot use — the same constraint analytics is built around.
 * But the two are answering different questions. A metric that is six hours
 * stale is a slightly old number; **a comment that is six hours stale is a
 * customer who has been waiting six hours.** Community management is the one
 * part of this product where latency is the product.
 *
 * | What | How often | Why |
 * |---|---|---|
 * | Posts younger than 48h | every 15 min | Where almost all comments arrive, and where a slow reply is most visible |
 * | Posts 2–14 days old | every 2h | The tail; still worth answering, rarely urgent |
 * | Posts older than 14 days | never swept | A comment on a three-week-old post is rare enough to not be worth the quota of checking every post forever |
 *
 * The last row is a real trade and worth naming: a comment on an old post is
 * missed entirely rather than found late. Webhooks are the answer to that —
 * Facebook can push a `feed` change — and are the natural next step, at which
 * point this sweep becomes the backstop rather than the mechanism.
 */

/** Posts younger than this are read on the fast cadence. */
export const HOT_POST_AGE_MS = 48 * 60 * 60 * 1_000;

/** Beyond this a post is not swept at all. See the table above. */
export const SWEEP_HORIZON_MS = 14 * 24 * 60 * 60 * 1_000;

export const HOT_INTERVAL_MS = 15 * 60 * 1_000;
export const TAIL_INTERVAL_MS = 2 * 60 * 60 * 1_000;

/** How many one pass will queue. A backlog drains over later passes. */
const SWEEP_BATCH = 300;

export interface CommentSweepResult {
  posts: number;
  failed: number;
}

export async function sweepComments(correlationId: string): Promise<CommentSweepResult> {
  const now = clock.now();
  const result: CommentSweepResult = { posts: 0, failed: 0 };

  const horizon = new Date(now.getTime() - SWEEP_HORIZON_MS);
  const hotFrom = new Date(now.getTime() - HOT_POST_AGE_MS);

  const candidates = await platformDb.postVariant.findMany({
    where: {
      deletedAt: null,
      status: 'PUBLISHED',
      externalPostId: { not: null },
      publishedAt: { gte: horizon },
      socialAccount: { deletedAt: null, status: { in: ['ACTIVE', 'NEEDS_RECONNECT'] } },
    },
    select: {
      id: true,
      organizationId: true,
      socialAccountId: true,
      publishedAt: true,
    },
    // Newest first, so when a backlog exceeds the batch the posts people are
    // actually watching are the ones that get read.
    orderBy: { publishedAt: 'desc' },
    take: SWEEP_BATCH,
  });

  for (const variant of candidates) {
    const publishedAt = variant.publishedAt;
    if (!publishedAt) continue;

    const interval = publishedAt >= hotFrom ? HOT_INTERVAL_MS : TAIL_INTERVAL_MS;

    /**
     * One job id per variant per interval bucket.
     *
     * Two workers sweeping at the same moment produce one job rather than two,
     * and BullMQ drops the duplicate. This is also what makes the cadence work
     * without storing a "last read" anywhere: the bucket *is* the schedule, so
     * a sweep running every five minutes still only queues a hot post once
     * every fifteen.
     *
     * Hyphens, not colons — BullMQ rejects a custom id containing `:` unless it
     * splits into exactly three parts, a carve-out its own source marks for
     * removal.
     */
    const window = Math.floor(now.getTime() / interval);

    try {
      await enqueue(
        'engagement',
        {
          organizationId: variant.organizationId,
          correlationId,
          socialAccountId: variant.socialAccountId,
          postVariantId: variant.id,
        },
        { jobId: `comments-${variant.id}-${window}` },
      );

      result.posts += 1;
    } catch (error) {
      // One bad variant must not abandon the rest of the sweep.
      result.failed += 1;
      logger.error('failed to enqueue comment ingestion', {
        postVariantId: variant.id,
        organizationId: variant.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.posts > 0 || result.failed > 0) {
    logger.info('comment sweep complete', { ...result });
  }

  return result;
}
