import {
  assertTransition,
  clock,
  InvalidStateTransitionError,
  postStatusFor,
  summariseVariants,
  type PostStatus,
} from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';

/**
 * Rolling variant outcomes up to the post (SRS §13, §14).
 *
 * A post publishes to several accounts, and they do not all succeed or fail
 * together. The post settles **once**, when every variant has an outcome —
 * `postStatusFor` returns `null` while any is still in flight, which is what
 * stops a post flipping to FAILED because the first of three accounts errored
 * while the others were still going.
 *
 * The transition goes through the same state machine every other status change
 * uses, with `actor: 'SYSTEM'` — the one place that actor is legitimate.
 * `PUBLISHING → PUBLISHED | PARTIALLY_PUBLISHED | FAILED` exists only for
 * SYSTEM, so no human role can reach these however their permissions are
 * configured (docs/RBAC.md §5).
 */

/**
 * Move the post to `PUBLISHING` once its first variant is claimed.
 *
 * The post has its own place in the state machine, and `SCHEDULED → PUBLISHED`
 * does not exist — publishing passes *through* `PUBLISHING`, for both the
 * variant and the post. Without this the rollup would have nowhere legal to go,
 * which is exactly how this was caught: `assertTransition` refused it.
 *
 * Idempotent and guarded on the current status, so the second and third
 * variants of a multi-account post find it already moved and do nothing.
 */
export async function markPostPublishing(postId: string): Promise<boolean> {
  const post = await platformDb.post.findUnique({
    where: { id: postId },
    select: { status: true },
  });

  if (!post || post.status !== 'SCHEDULED') return false;

  try {
    assertTransition('SCHEDULED', 'PUBLISHING', 'SYSTEM');
  } catch {
    return false;
  }

  const updated = await platformDb.post.updateMany({
    where: { id: postId, status: 'SCHEDULED' },
    data: { status: 'PUBLISHING' },
  });

  return updated.count === 1;
}

export interface RollupResult {
  settled: boolean;
  status: PostStatus | null;
  published: number;
  failed: number;
  needsReview: number;
  pending: number;
}

/**
 * Settle the post if every variant is done.
 *
 * Safe to call after each variant finishes: the ones that find work still
 * pending do nothing, and only the last one in settles the post.
 */
export async function rollUpPost(postId: string): Promise<RollupResult> {
  const post = await platformDb.post.findUnique({
    where: { id: postId },
    select: {
      status: true,
      organizationId: true,
      workspaceId: true,
      brandId: true,
      variants: { where: { deletedAt: null }, select: { status: true } },
    },
  });

  if (!post) {
    return { settled: false, status: null, published: 0, failed: 0, needsReview: 0, pending: 0 };
  }

  const summary = summariseVariants(post.variants.map((variant) => variant.status));
  const target = postStatusFor(summary);

  const result: RollupResult = {
    settled: false,
    status: target,
    published: summary.published,
    failed: summary.failed,
    needsReview: summary.needsReview,
    pending: summary.pending,
  };

  if (target === null || target === post.status) return result;

  try {
    // The machine is consulted even here. If a future change removed one of
    // these transitions, this would fail loudly rather than write a status the
    // domain no longer recognises.
    assertTransition(post.status, target, 'SYSTEM');
  } catch (error) {
    if (error instanceof InvalidStateTransitionError) {
      // The post moved under us — cancelled mid-publish, most likely. The
      // variants' own outcomes are already recorded and stand.
      logger.warn('post moved before its publish outcome could be applied', {
        postId,
        from: post.status,
        to: target,
      });
      return result;
    }
    throw error;
  }

  const now = clock.now();

  // Guarded on the status we read, so two variants finishing at once settle the
  // post once rather than racing.
  const updated = await platformDb.post.updateMany({
    where: { id: postId, status: post.status },
    data: {
      status: target,
      // The DB check constraint requires a timestamp alongside PUBLISHED, and
      // it is the moment the post as a whole completed.
      ...(target === 'PUBLISHED' || target === 'PARTIALLY_PUBLISHED' ? { publishedAt: now } : {}),
    },
  });

  if (updated.count !== 1) return result;

  result.settled = true;

  await platformDb.auditLog.create({
    data: {
      organizationId: post.organizationId,
      actorUserId: null,
      actorType: 'WORKER',
      action: 'post.publish_settled',
      resourceType: 'Post',
      resourceId: postId,
      workspaceId: post.workspaceId,
      brandId: post.brandId,
      before: { status: post.status },
      after: {
        status: target,
        published: summary.published,
        failed: summary.failed,
        needsReview: summary.needsReview,
      },
      correlationId: null,
    },
  });

  logger.info('post publishing settled', {
    postId,
    organizationId: post.organizationId,
    status: target,
    published: summary.published,
    failed: summary.failed,
    needsReview: summary.needsReview,
  });

  return result;
}
