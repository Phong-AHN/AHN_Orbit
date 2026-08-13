import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  accessibleWorkspaceIds,
  assertAnswersCurrentGate,
  isUserPrincipal,
  statusAfterDecision,
  type ApprovalDecision,
  type ApprovalStage,
  type ApprovalState,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { CLIENT_VISIBLE_STATUSES } from '@orbit/rbac';
import { logger } from '@orbit/observability';
import { audit, type AuditInput } from '@/server/audit';
import { transitionPost } from '@/features/posts/service';
import { APPROVAL_SELECT, recordDecision } from './records';

/**
 * The approval gate (SRS §15, docs/RBAC.md §5).
 *
 * Deciding an approval is not a second way to move a post. The decision is
 * recorded, and the resulting status change goes through `transitionPost` —
 * the same state machine, the same permission check, the same validation and
 * the same audit row every other status change uses. If the transition is
 * refused, the decision is never written.
 */

const POST_FOR_DECISION = {
  id: true,
  status: true,
  workspaceId: true,
  brandId: true,
  createdById: true,
  approvalRequired: true,
  deletedAt: true,
} as const;

export interface DecideApprovalInput {
  decision: ApprovalDecision;
  comment?: string | undefined;
  /**
   * The reviewer is recording a client's decision relayed by phone or email
   * (docs/RBAC.md note 5). Requires `reason`, and is always audited as such.
   */
  onBehalfOf?: boolean | undefined;
  reason?: string | undefined;
}

/**
 * Record a decision and move the post.
 *
 * Order matters. The approval is resolved and checked against the post's
 * *current* status first, so a stale id from an earlier round cannot answer a
 * gate that has since moved on. Then `transitionPost` rules on whether this
 * principal may make the resulting move — which is where a Client trying to
 * approve at `INTERNAL_REVIEW` is refused, by the same grant matrix that
 * governs the direct transition endpoint.
 */
export async function decideApproval(
  ctx: TenantContext,
  approvalId: string,
  input: DecideApprovalInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const onBehalfOf = input.onBehalfOf ?? false;

  // An on-behalf-of decision loses the client's own attestation, so the note
  // explaining where the approval actually came from is not optional.
  if (onBehalfOf && !input.reason?.trim()) {
    throw new ValidationError('Recording a decision on someone else’s behalf requires a reason', {
      userMessage:
        'Say where this decision came from — a phone call, an email — before recording it for the client.',
      details: [{ field: 'reason', issue: 'required when onBehalfOf is set' }],
    });
  }

  const { approval, post } = await withTenant(ctx, async (db) => {
    const found = await db.approval.findFirst({
      where: { id: approvalId },
      select: { ...APPROVAL_SELECT, post: { select: POST_FOR_DECISION } },
    });
    // Scoped client: an approval in another organization simply is not here.
    if (!found) throw new NotFoundError('Approval');
    if (found.post.deletedAt) throw new NotFoundError('Approval');

    return { approval: found, post: found.post };
  });

  // The post's status is the authority on which gate is open — not the record.
  assertAnswersCurrentGate(post.status, approval.stage, approval.state);

  // Only an internal role may relay a client's decision; a Client recording one
  // "on behalf of" themselves is meaningless, and on behalf of anyone else is
  // exactly what this must not allow.
  if (onBehalfOf) {
    assertMayActOnBehalfOfClient(ctx, approval.stage);
  }

  const to = statusAfterDecision(approval.stage, input.decision, post.approvalRequired);

  // `transitionPost` enforces the machine, the permission and the validation,
  // and only then runs the callback — so the decision row is written in the
  // same transaction as the status change, or not at all.
  const updated = await transitionPost(ctx, post.id, to, fingerprint, {
    comment: input.comment,
    onTransition: async (db) => {
      const landed = await recordDecision(db, ctx, approvalId, {
        state: input.decision,
        comment: input.comment,
        onBehalfOf,
      });

      if (!landed) {
        // Someone answered this gate between our read and our write. Throwing
        // inside the transaction rolls the status change back with it.
        throw new ConflictError('That review was already answered', {
          userMessage: 'Someone else answered this review a moment ago. Reload to see the outcome.',
          context: { approvalId },
        });
      }

      await audit(db, ctx, {
        action: onBehalfOf ? 'approval.approved_on_behalf_of' : 'approval.decided',
        resourceType: 'Approval',
        resourceId: approvalId,
        workspaceId: post.workspaceId,
        brandId: post.brandId,
        before: { state: 'PENDING', stage: approval.stage, round: approval.round },
        after: { state: input.decision, resultingStatus: to },
        reason: input.reason ?? input.comment,
        ...fingerprint,
      });
    },
  });

  if (onBehalfOf) {
    logger.warn('client decision recorded by an internal user', {
      securityEvent: true,
      approvalId,
      postId: post.id,
      stage: approval.stage,
    });
  }

  return { post: updated, approvalId, decision: input.decision };
}

/**
 * Only internal roles may relay a client's decision.
 *
 * The grant matrix already gives `post:approve_client` to internal roles for
 * exactly this reason, so this adds one thing the matrix cannot express: that
 * the flag is meaningless unless the actor is *not* the client.
 */
function assertMayActOnBehalfOfClient(ctx: TenantContext, stage: ApprovalStage): void {
  if (stage !== 'CLIENT') {
    throw new ValidationError('Only a client decision can be recorded on someone’s behalf', {
      userMessage: 'Internal reviews are recorded by the reviewer, not on anyone’s behalf.',
    });
  }

  if (isUserPrincipal(ctx.principal) && ctx.principal.organizationRole === 'CLIENT') {
    throw new ForbiddenError('A client cannot record a decision on another client’s behalf', {
      userMessage: 'You can only record your own decision.',
    });
  }
}

// ── Queue and timeline ──────────────────────────────────────────────────────

export interface ApprovalQueueFilter {
  stage?: ApprovalStage;
  state?: ApprovalState;
  workspaceId?: string;
  brandId?: string;
  limit?: number;
}

/**
 * The reviewer's queue.
 *
 * Narrowed twice over: to the tenant by the scoped client, and to the
 * workspaces this principal can reach at all. A Client is narrowed a third
 * time, to posts whose status has actually reached them — so a pending internal
 * review is invisible in the portal even though the row exists.
 */
export async function listApprovalQueue(ctx: TenantContext, filter: ApprovalQueueFilter = {}) {
  const workspaces = accessibleWorkspaceIds(ctx);
  const isClient = isUserPrincipal(ctx.principal) && ctx.principal.organizationRole === 'CLIENT';

  return withTenant(ctx, (db) =>
    db.approval.findMany({
      where: {
        state: filter.state ?? 'PENDING',
        ...(filter.stage ? { stage: filter.stage } : {}),
        post: {
          deletedAt: null,
          ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
          ...(filter.brandId ? { brandId: filter.brandId } : {}),
          ...(workspaces === 'ALL' ? {} : { workspaceId: { in: [...workspaces] } }),
          ...(isClient ? { status: { in: [...CLIENT_VISIBLE_STATUSES] } } : {}),
        },
      },
      select: {
        ...APPROVAL_SELECT,
        post: {
          select: {
            id: true,
            title: true,
            body: true,
            status: true,
            workspaceId: true,
            brandId: true,
            scheduledFor: true,
          },
        },
      },
      orderBy: { requestedAt: 'asc' },
      take: Math.min(filter.limit ?? 50, 200),
    }),
  );
}

/**
 * Every decision ever made on a post, oldest first — the status timeline.
 *
 * Includes cancelled rounds on purpose: "this was approved, then reopened, then
 * approved again" is the story an audit needs to be able to tell.
 */
export async function listApprovalsForPost(ctx: TenantContext, postId: string) {
  return withTenant(ctx, async (db) => {
    const post = await db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: { id: true },
    });
    if (!post) throw new NotFoundError('Post');

    return db.approval.findMany({
      where: { postId },
      select: {
        ...APPROVAL_SELECT,
        requestedBy: { select: { id: true, name: true, email: true } },
        decidedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ round: 'asc' }, { requestedAt: 'asc' }],
    });
  });
}

/** Resolve an approval's post for the route-level permission check. */
export async function approvalScope(ctx: TenantContext, approvalId: string) {
  return withTenant(ctx, async (db) => {
    const approval = await db.approval.findFirst({
      where: { id: approvalId },
      select: { post: { select: POST_FOR_DECISION } },
    });
    if (!approval) throw new NotFoundError('Approval');
    return approval.post;
  });
}
