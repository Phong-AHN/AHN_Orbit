import { ConflictError, NotFoundError, ValidationError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { decideApproval } from '@/features/approvals/service';
import { createComment } from '@/features/comments/service';
import type { AuditInput } from '@/server/audit';
import { PORTAL_APPROVAL_SELECT, PORTAL_COMMENT_SELECT, PORTAL_POST_SELECT } from './projection';
import { requirePortalPost } from './service';
import type { PortalCommentInput, PortalDecisionInput } from './contracts';

/**
 * What a client can actually *do* (SRS §21).
 *
 * These delegate. Decision D-012 requires the portal to own its **reads** —
 * different selects, different code path — but a write is a different problem:
 * there must be exactly one state machine (**D-017**) and one place that decides
 * what a review decision means. A portal-local reimplementation of "approve"
 * would be the second workflow engine the architecture spends most of its effort
 * avoiding.
 *
 * So the shape is: resolve and narrow *here*, then hand to the domain service,
 * which re-runs its own authorization. Two independent checks, neither relying
 * on the other having happened.
 */

/**
 * Record the client's decision on a post.
 *
 * The portal addresses a **post**, not an approval id — a client has no reason
 * to know that approvals are rows, and exposing the id would invite passing a
 * stale one. The open gate is resolved here, narrowed to
 * `stage: 'CLIENT'` + `state: 'PENDING'`, and `decideApproval` then re-checks
 * that it answers the post's *current* status before the state machine rules on
 * whether this principal may make the resulting move.
 */
export async function decidePortalPost(
  ctx: TenantContext,
  workspaceId: string,
  postId: string,
  input: PortalDecisionInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  // 404 unless this post is one the client may see at all.
  await requirePortalPost(ctx, workspaceId, postId);

  // Asking for changes without saying what they are leaves the agency guessing
  // and the client waiting. Approving needs no words.
  if (input.decision === 'CHANGES_REQUESTED' && !input.comment?.trim()) {
    throw new ValidationError('Requested changes need a note', {
      userMessage: 'Tell us what to change, so we can put it right.',
      details: [{ field: 'comment', issue: 'required when requesting changes' }],
    });
  }

  const approval = await withTenant(ctx, async (db) => {
    const open = await db.approval.findFirst({
      where: { postId, stage: 'CLIENT', state: 'PENDING' },
      select: { id: true },
      orderBy: { round: 'desc' },
    });

    if (!open) {
      // Either it was never with them, or somebody answered it first. Both mean
      // there is nothing here to decide.
      throw new ConflictError('This post is not waiting for your approval', {
        userMessage: 'This post is no longer waiting on you. Refresh to see where it got to.',
        context: { postId },
      });
    }

    return open;
  });

  const result = await decideApproval(
    ctx,
    approval.id,
    {
      decision: input.decision,
      ...(input.comment ? { comment: input.comment } : {}),
      // Never set from the portal. A client records their own decision, and
      // `decideApproval` refuses `onBehalfOf` from a Client principal anyway.
      onBehalfOf: false,
    },
    fingerprint,
  );

  // Re-read through the portal projection rather than returning the agency post
  // that `decideApproval` hands back — that object carries `createdById`,
  // `assignedToId` and `approvalRequired`.
  return withTenant(ctx, async (db) => {
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: PORTAL_POST_SELECT,
    });
    if (!post) throw new NotFoundError('Post');

    const gate = await db.approval.findFirst({
      where: { id: approval.id },
      select: PORTAL_APPROVAL_SELECT,
    });

    return { post, approval: gate, decision: result.decision };
  });
}

/**
 * Leave a comment.
 *
 * `createComment` forces a Client's comment to `CLIENT_VISIBLE` and refuses a
 * reply into a thread they cannot see (T1.10), so this adds only the portal's
 * own narrowing: the post must be one they may read, and the returned row goes
 * through the portal projection rather than the agency one — which carries the
 * author's email and the `visibility` flag.
 */
export async function commentOnPortalPost(
  ctx: TenantContext,
  workspaceId: string,
  postId: string,
  input: PortalCommentInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  await requirePortalPost(ctx, workspaceId, postId);

  const created = await createComment(
    ctx,
    postId,
    {
      body: input.body,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      // Stated rather than omitted, so this file says out loud what the client
      // is permitted to write. `createComment` would force it regardless.
      visibility: 'CLIENT_VISIBLE',
    },
    fingerprint,
  );

  return withTenant(ctx, (db) =>
    db.comment.findFirst({ where: { id: created.id }, select: PORTAL_COMMENT_SELECT }),
  );
}
