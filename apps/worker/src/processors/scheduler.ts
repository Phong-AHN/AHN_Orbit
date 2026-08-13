import { SCHEDULE_TOLERANCE_MS, clock, isStale, publishIdempotencyKey } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import { enqueue } from '@orbit/queue';

/**
 * The scheduler sweep (docs/ARCHITECTURE.md §5.1, assumption C10).
 *
 * Runs every 30 seconds, finds variants whose time has come, and enqueues one
 * publish job each. Scheduling is deliberately **not** one delayed BullMQ job
 * per post: rescheduling and cancellation would become queue surgery, and the
 * database would stop being the source of truth.
 *
 * Four things make this safe to run on several workers at once:
 *
 *   1. the `PublishingJob` row is unique on `(postVariantId, idempotencyKey)`,
 *      so a second sweep's insert conflicts rather than creating a twin;
 *   2. the BullMQ job id **is** that idempotency key, so a duplicate add is
 *      silently dropped (idempotency layer 1);
 *   3. nothing here mutates the variant — the publish engine's atomic claim
 *      (layer 2) decides who actually publishes;
 *   4. an enqueue that fails leaves the variant `SCHEDULED`, so the next sweep
 *      retries it. Being 30 seconds late is recoverable; publishing twice is not.
 *
 * This is one of the two places that read unscoped, because a sweep is
 * platform-wide by nature. Every row carries its own `organizationId`, and the
 * publish processor derives its tenant from the row rather than from the
 * payload (decision D-021).
 */

export interface SweepResult {
  due: number;
  enqueued: number;
  /** Already had a job row and a queued job; nothing to do. */
  duplicate: number;
  /** Too late to publish unattended. Surfaced for a human instead. */
  stale: number;
  failed: number;
  /** Due, but their account needs reconnecting. Left scheduled (T1.7). */
  paused: number;
}

/** How many variants one sweep will handle. A backlog drains over several passes. */
const SWEEP_BATCH = 200;

export async function sweepDueVariants(correlationId: string): Promise<SweepResult> {
  const now = clock.now();
  const result: SweepResult = { due: 0, enqueued: 0, duplicate: 0, stale: 0, failed: 0, paused: 0 };

  const readyWindow = {
    status: 'SCHEDULED' as const,
    deletedAt: null,
    scheduledFor: { lte: new Date(now.getTime() + SCHEDULE_TOLERANCE_MS) },
    // Only variants whose post reached SCHEDULED as a whole. One left behind
    // on a post that was pulled back must not publish on its own.
    post: { status: 'SCHEDULED' as const, deletedAt: null },
  };

  /**
   * An account that needs reconnecting cannot publish, so queueing its variants
   * would spend a job, an attempt row and a log line to reach the engine's own
   * refusal — once every 30 seconds, per post, until someone noticed (T1.7).
   *
   * Skipping is not cancelling. The variants stay `SCHEDULED` with their times
   * intact, so reconnecting the account is all it takes for the next sweep to
   * pick them up. The engine keeps its own `ACTIVE` check regardless: this is a
   * cheaper first filter, not a replacement for the guard that actually
   * guarantees nothing publishes through a dead credential.
   */
  const publishable = { socialAccount: { status: 'ACTIVE' as const, deletedAt: null } };

  const due = await platformDb.postVariant.findMany({
    where: { ...readyWindow, ...publishable },
    select: {
      id: true,
      organizationId: true,
      scheduledFor: true,
      contentHash: true,
    },
    orderBy: { scheduledFor: 'asc' },
    take: SWEEP_BATCH,
  });

  // Counted rather than inferred, because "nothing was due" and "everything due
  // is stuck behind a broken account" look identical in the log otherwise.
  result.paused = await platformDb.postVariant.count({
    where: { ...readyWindow, socialAccount: { status: { not: 'ACTIVE' } } },
  });

  result.due = due.length;
  if (due.length === 0) {
    if (result.paused > 0) {
      logger.warn('scheduled posts are waiting on accounts that need reconnecting', {
        paused: result.paused,
      });
    }
    return result;
  }

  for (const variant of due) {
    const { scheduledFor, contentHash } = variant;

    // The partial index guarantees `status = 'SCHEDULED'`, and a DB check
    // constraint guarantees such a row has a `scheduledFor` — but the column is
    // nullable, so this narrows rather than assumes.
    if (!scheduledFor) continue;

    // Without a content hash there is no stable idempotency key, and without
    // that a retry could double-publish. `schedulePost` always writes one, so
    // this means something wrote the row another way.
    if (!contentHash) {
      result.failed += 1;
      logger.error('scheduled variant has no content hash; refusing to enqueue', {
        variantId: variant.id,
        organizationId: variant.organizationId,
      });
      continue;
    }

    const idempotencyKey = publishIdempotencyKey({
      postVariantId: variant.id,
      scheduledFor,
      contentHash,
    });

    try {
      const job = await claimPublishingJob({
        organizationId: variant.organizationId,
        postVariantId: variant.id,
        idempotencyKey,
        scheduledFor,
      });

      if (!job.created) {
        // Another sweep already queued this exact publish.
        result.duplicate += 1;
        continue;
      }

      await enqueue(
        'publish',
        {
          organizationId: variant.organizationId,
          // One sweep is one causal event, so the batch shares a correlation
          // id — a fresh id per variant would make the sweep unreadable in logs.
          correlationId,
          postVariantId: variant.id,
          idempotencyKey,
          publishingJobId: job.id,
        },
        { jobId: idempotencyKey },
      );

      result.enqueued += 1;
    } catch (error) {
      // One bad variant must not abandon the rest of the sweep.
      result.failed += 1;
      logger.error('failed to enqueue a due variant', {
        variantId: variant.id,
        organizationId: variant.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.enqueued > 0 || result.failed > 0 || result.stale > 0 || result.paused > 0) {
    logger.info('scheduler sweep complete', { ...result });
  }

  return result;
}

/**
 * Create the durable record of this publish attempt, or discover it exists.
 *
 * The unique constraint on `(postVariantId, idempotencyKey)` is what makes this
 * a claim rather than a check-then-insert: two workers racing produce one row
 * and one winner, with no window between the read and the write.
 */
async function claimPublishingJob(input: {
  organizationId: string;
  postVariantId: string;
  idempotencyKey: string;
  scheduledFor: Date;
}): Promise<{ id: string; created: boolean }> {
  const existing = await platformDb.publishingJob.findUnique({
    where: {
      postVariantId_idempotencyKey: {
        postVariantId: input.postVariantId,
        idempotencyKey: input.idempotencyKey,
      },
    },
    select: { id: true },
  });

  if (existing) return { id: existing.id, created: false };

  try {
    const created = await platformDb.publishingJob.create({
      data: {
        organizationId: input.organizationId,
        postVariantId: input.postVariantId,
        idempotencyKey: input.idempotencyKey,
        scheduledFor: input.scheduledFor,
        state: 'QUEUED',
      },
      select: { id: true },
    });

    return { id: created.id, created: true };
  } catch (error) {
    // Lost the race. The other worker's row is the one to use, and it has
    // already enqueued the job.
    if (isUniqueViolation(error)) {
      const winner = await platformDb.publishingJob.findUnique({
        where: {
          postVariantId_idempotencyKey: {
            postVariantId: input.postVariantId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { id: true },
      });

      if (winner) return { id: winner.id, created: false };
    }

    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Mark variants that are too late to publish unattended.
 *
 * Separate from the sweep because it is a *decision about people*, not about
 * queueing: publishing a "good morning" at 4pm because the workers were down
 * for six hours is worse than not publishing it. These are reported now and get
 * a proper surface in T1.14.
 */
export async function reportStaleSchedules(): Promise<number> {
  const now = clock.now();

  const overdue = await platformDb.postVariant.findMany({
    where: {
      status: 'SCHEDULED',
      deletedAt: null,
      scheduledFor: { lt: now },
      post: { status: 'SCHEDULED', deletedAt: null },
    },
    select: { id: true, organizationId: true, scheduledFor: true },
    take: SWEEP_BATCH,
  });

  const stale = overdue.filter(
    (variant) => variant.scheduledFor && isStale(variant.scheduledFor, now),
  );

  if (stale.length > 0) {
    logger.error('scheduled posts are too late to publish unattended', {
      count: stale.length,
      variantIds: stale.map((variant) => variant.id),
      note: 'left SCHEDULED for a human to decide (T1.14)',
    });
  }

  return stale.length;
}
