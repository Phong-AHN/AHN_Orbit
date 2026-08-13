import {
  actorUserId,
  clock,
  stageForStatus,
  type PostStatus,
  type TenantContext,
} from '@orbit/core';
import type { TenantDb } from '@orbit/db';

/**
 * Approval row mechanics (SRS §15).
 *
 * A leaf module on purpose: the posts service calls into it from inside the
 * transition transaction, and it calls nothing back. That keeps the approval
 * record and the status change in one transaction without the two features
 * importing each other.
 *
 * Nothing here decides anything. Whether a transition is legal, and whether
 * this principal may make it, has already been settled by the state machine and
 * the policy engine before any of this runs.
 */

export const APPROVAL_SELECT = {
  id: true,
  postId: true,
  stage: true,
  state: true,
  round: true,
  comment: true,
  onBehalfOf: true,
  requestedById: true,
  requestedAt: true,
  decidedById: true,
  decidedAt: true,
} as const;

/**
 * The round a post is currently in.
 *
 * A round is one pass through review. It advances when reopened content is
 * resubmitted, so the history of an earlier round stays legible rather than
 * being overwritten or deleted.
 */
async function currentRound(db: TenantDb, postId: string): Promise<number> {
  const latest = await db.approval.findFirst({
    where: { postId },
    orderBy: { round: 'desc' },
    select: { round: true },
  });
  return latest?.round ?? 0;
}

/**
 * Open the gate a post has just entered, if it entered one.
 *
 * Called from inside the transition transaction, so a post can never sit in
 * `INTERNAL_REVIEW` with nothing in anyone's queue.
 *
 * Entering `INTERNAL_REVIEW` starts a new round; entering `CLIENT_REVIEW`
 * continues the round the internal approval belonged to, because it is the same
 * pass over the same content.
 */
export async function openGateFor(
  db: TenantDb,
  ctx: TenantContext,
  post: { id: string },
  to: PostStatus,
): Promise<void> {
  const stage = stageForStatus(to);
  if (stage === null) return;

  const round = await currentRound(db, post.id);

  await db.approval.create({
    data: {
      organizationId: ctx.organizationId,
      postId: post.id,
      stage,
      state: 'PENDING',
      // Who asked for the review, taken from the session — never the request.
      requestedById: actorUserId(ctx),
      round: stage === 'INTERNAL' ? round + 1 : Math.max(round, 1),
    },
  });
}

/**
 * Cancel every open gate on a post.
 *
 * Used when content is reopened: the approvals that were granted were granted
 * for the old version, so a new round has to be requested. Returns how many
 * were voided, for the log.
 */
export async function voidOpenGates(db: TenantDb, postId: string): Promise<number> {
  const { count } = await db.approval.updateMany({
    where: { postId, state: 'PENDING' },
    data: { state: 'CANCELED' },
  });
  return count;
}

/**
 * Stamp a reviewer's decision onto the pending record.
 *
 * Returns whether it landed. `state: 'PENDING'` in the filter makes this a
 * compare-and-set: if two reviewers answer the same gate at once the second
 * updates nothing and is told the review was already answered, rather than
 * silently overwriting the first reviewer's decision and comment.
 */
export async function recordDecision(
  db: TenantDb,
  ctx: TenantContext,
  approvalId: string,
  input: { state: 'APPROVED' | 'CHANGES_REQUESTED'; comment?: string; onBehalfOf: boolean },
): Promise<boolean> {
  const { count } = await db.approval.updateMany({
    where: { id: approvalId, state: 'PENDING' },
    data: {
      state: input.state,
      decidedById: actorUserId(ctx),
      decidedAt: clock.now(),
      comment: input.comment ?? null,
      onBehalfOf: input.onBehalfOf,
    },
  });
  return count === 1;
}
