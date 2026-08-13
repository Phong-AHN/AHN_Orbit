import {
  ConflictError,
  NotFoundError,
  ValidationError,
  clock,
  contentHash,
  publishIdempotencyKey,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { enqueue } from '@orbit/queue';
import { logger } from '@orbit/observability';
import { audit, type AuditInput } from '@/server/audit';
import { transitionPost } from '@/features/posts/service';

/**
 * Publish now (SRS §13).
 *
 * "Publish now" is **scheduling for the present**, not a separate path. It
 * moves the post through the same `APPROVED → SCHEDULED` transition, stamps the
 * same content hash, and derives the same idempotency key — the only difference
 * is that the instant is now and the job is enqueued directly rather than
 * waiting for the sweep.
 *
 * Doing it any other way would mean two routes into the publishing engine with
 * two chances to get idempotency wrong. This way, a "publish now" that races
 * the sweep produces the same key and BullMQ drops the duplicate.
 */

export async function publishNow(
  ctx: TenantContext,
  postId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const now = clock.now();

  // The status change goes through the machine, which checks `post:schedule`
  // and re-runs validation — publishing now must not skip either.
  const post = await transitionPost(ctx, postId, 'SCHEDULED', fingerprint, {
    onTransition: async (db) => {
      const found = await db.post.findFirst({
        where: { id: postId, deletedAt: null },
        select: {
          body: true,
          workspaceId: true,
          brandId: true,
          media: {
            where: { postVariantId: null },
            orderBy: { position: 'asc' },
            select: { mediaAssetId: true },
          },
          variants: {
            where: { deletedAt: null, status: { in: ['DRAFT', 'SCHEDULED'] } },
            select: {
              id: true,
              body: true,
              linkUrl: true,
              media: { orderBy: { position: 'asc' }, select: { mediaAssetId: true } },
            },
          },
        },
      });
      if (!found) throw new NotFoundError('Post');

      if (found.variants.length === 0) {
        throw new ValidationError('Post has no accounts to publish to', {
          userMessage: 'Choose at least one account before publishing.',
          details: [{ field: 'socialAccountIds', issue: 'none selected' }],
        });
      }

      await db.post.update({ where: { id: postId }, data: { scheduledFor: now } });

      for (const variant of found.variants) {
        const media = variant.media.length > 0 ? variant.media : found.media;

        await db.postVariant.update({
          where: { id: variant.id },
          data: {
            scheduledFor: now,
            status: 'SCHEDULED',
            contentHash: contentHash({
              body: variant.body.length > 0 ? variant.body : found.body,
              linkUrl: variant.linkUrl,
              mediaKeys: media.map((item) => item.mediaAssetId),
            }),
          },
        });
      }

      await audit(db, ctx, {
        action: 'post.publish_now',
        resourceType: 'Post',
        resourceId: postId,
        workspaceId: found.workspaceId,
        brandId: found.brandId,
        after: { scheduledFor: now.toISOString(), variants: found.variants.length },
        ...fingerprint,
      });
    },
  });

  // Enqueue directly so it does not wait up to 30s for the sweep. The sweep
  // would find these anyway; identical keys mean whichever gets there first
  // wins and the other is dropped.
  const enqueued = await enqueueDuePublishes(ctx, postId);

  logger.info('publish now requested', { postId, organizationId: ctx.organizationId, enqueued });

  return { post, enqueued };
}

/**
 * Queue every publishable variant of a post.
 *
 * Mirrors the sweep exactly — same `PublishingJob` claim on
 * `(postVariantId, idempotencyKey)`, same key as the BullMQ job id — so the two
 * producers can race safely.
 */
async function enqueueDuePublishes(ctx: TenantContext, postId: string): Promise<number> {
  const variants = await withTenant(ctx, (db) =>
    db.postVariant.findMany({
      where: { postId, status: 'SCHEDULED', deletedAt: null },
      select: { id: true, scheduledFor: true, contentHash: true },
    }),
  );

  let enqueued = 0;

  for (const variant of variants) {
    // Hoisted out of the row so the narrowing survives into the closure below.
    const { scheduledFor, contentHash: hash } = variant;
    if (!scheduledFor || !hash) continue;

    const idempotencyKey = publishIdempotencyKey({
      postVariantId: variant.id,
      scheduledFor,
      contentHash: hash,
    });

    const job = await withTenant(ctx, async (db) => {
      const existing = await db.publishingJob.findFirst({
        where: { postVariantId: variant.id, idempotencyKey },
        select: { id: true },
      });
      if (existing) return { id: existing.id, created: false };

      const created = await db.publishingJob.create({
        data: {
          organizationId: ctx.organizationId,
          postVariantId: variant.id,
          idempotencyKey,
          scheduledFor,
          state: 'QUEUED',
        },
        select: { id: true },
      });
      return { id: created.id, created: true };
    });

    if (!job.created) continue;

    await enqueue(
      'publish',
      {
        organizationId: ctx.organizationId,
        correlationId: ctx.correlationId,
        postVariantId: variant.id,
        idempotencyKey,
        publishingJobId: job.id,
      },
      { jobId: idempotencyKey, priority: 1 },
    );

    enqueued += 1;
  }

  return enqueued;
}

/**
 * Retry the accounts that failed on a partly-published post.
 *
 * Only `FAILED` variants are touched. A published one must never be
 * re-attempted, and one parked as `NEEDS_REVIEW` is waiting on a human — an
 * automatic retry there would be the guess the design forbids.
 */
export async function retryFailedVariants(
  ctx: TenantContext,
  postId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const now = clock.now();

  const retried = await withTenant(ctx, async (db) => {
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: { id: true, status: true, workspaceId: true, brandId: true },
    });
    if (!post) throw new NotFoundError('Post');

    if (post.status !== 'FAILED' && post.status !== 'PARTIALLY_PUBLISHED') {
      throw new ConflictError('Only a failed or partly published post can be retried', {
        userMessage: 'There is nothing to retry on this post.',
        context: { status: post.status },
      });
    }

    // Re-scheduling for now gives a *new* idempotency key, which is correct: a
    // retry is a new publish attempt at a new instant, and must not collapse
    // onto the job that already failed.
    const { count } = await db.postVariant.updateMany({
      where: { postId, status: 'FAILED' },
      // `lastError` is left as it was: it describes the attempt that failed,
      // and clearing it would erase the reason before anyone read it. The next
      // attempt overwrites it with its own outcome.
      data: { status: 'SCHEDULED', scheduledFor: now },
    });

    await audit(db, ctx, {
      action: 'post.publish_retried',
      resourceType: 'Post',
      resourceId: postId,
      workspaceId: post.workspaceId,
      brandId: post.brandId,
      after: { variants: count, scheduledFor: now.toISOString() },
      ...fingerprint,
    });

    return count;
  });

  if (retried === 0) {
    throw new ConflictError('No failed accounts to retry', {
      userMessage: 'Every account either published or is waiting for a decision.',
    });
  }

  const enqueued = await enqueueDuePublishes(ctx, postId);
  return { retried, enqueued };
}

/**
 * Retry one account's publish, by job (API §2.8).
 *
 * Goes back through the *existing* engine: the variant returns to `SCHEDULED`
 * at a new instant, which yields a new idempotency key, and all four layers
 * apply again on the next attempt. Nothing here talks to a provider.
 *
 * A parked variant is refused. `NEEDS_REVIEW` means nobody knows whether the
 * post went out, and retrying on that basis is precisely the guess the design
 * forbids — `/resolve` is the door for those.
 */
export async function retryPublishingJob(
  ctx: TenantContext,
  jobId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const now = clock.now();

  const variant = await withTenant(ctx, async (db) => {
    const job = await db.publishingJob.findFirst({
      where: { id: jobId },
      select: {
        id: true,
        postVariantId: true,
        postVariant: {
          select: {
            id: true,
            status: true,
            postId: true,
            socialAccount: { select: { displayName: true } },
            post: { select: { workspaceId: true, brandId: true } },
          },
        },
      },
    });
    if (!job) throw new NotFoundError('Publishing job');

    const target = job.postVariant;

    if (target.status === 'NEEDS_REVIEW') {
      throw new ConflictError('This publish needs a decision before it can be retried', {
        userMessage:
          "We couldn't confirm whether this went out. Check the account and record what you find before retrying.",
        context: { variantId: target.id },
      });
    }

    if (target.status === 'PUBLISHED') {
      throw new ConflictError('This account has already been published to', {
        userMessage: 'This account already has the post. Retrying would post it twice.',
      });
    }

    if (target.status === 'PUBLISHING') {
      throw new ConflictError('This publish is already running', {
        userMessage: 'This is publishing right now. Give it a moment.',
      });
    }

    await db.postVariant.update({
      where: { id: target.id },
      // `lastError` is left in place: it describes the attempt that failed, and
      // clearing it would erase the reason before anyone read it.
      data: { status: 'SCHEDULED', scheduledFor: now },
    });

    await audit(db, ctx, {
      action: 'post_variant.publish_retried',
      resourceType: 'PostVariant',
      resourceId: target.id,
      workspaceId: target.post.workspaceId,
      brandId: target.post.brandId,
      before: { status: target.status },
      after: { status: 'SCHEDULED', scheduledFor: now.toISOString() },
      ...fingerprint,
    });

    return target;
  });

  const enqueued = await enqueueDuePublishes(ctx, variant.postId);

  logger.info('publishing job retried', {
    jobId,
    variantId: variant.id,
    organizationId: ctx.organizationId,
    enqueued,
  });

  return { variantId: variant.id, postId: variant.postId, enqueued };
}

/** Publishing state for the post detail and calendar views (SRS §14). */
export async function getPublishingStatus(ctx: TenantContext, postId: string) {
  return withTenant(ctx, async (db) => {
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: {
        id: true,
        status: true,
        publishedAt: true,
        variants: {
          where: { deletedAt: null },
          select: {
            id: true,
            status: true,
            platform: true,
            externalPostId: true,
            externalPermalink: true,
            publishedAt: true,
            lastError: true,
            socialAccount: { select: { id: true, displayName: true } },
            jobs: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: {
                id: true,
                state: true,
                attemptCount: true,
                lastErrorCode: true,
                attempts: {
                  orderBy: { attemptNumber: 'desc' },
                  select: {
                    attemptNumber: true,
                    state: true,
                    startedAt: true,
                    finishedAt: true,
                    durationMs: true,
                    errorCode: true,
                    // The vetted message only — never a provider payload.
                    errorMessage: true,
                    errorRetryable: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!post) throw new NotFoundError('Post');
    return post;
  });
}
