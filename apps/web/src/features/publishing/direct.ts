import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type PostStatus,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { can, canTransition, type ResourceScope } from '@orbit/rbac';
import type { AuditInput } from '@/server/audit';
import { transitionPost } from '@/features/posts/service';
import { decideApproval } from '@/features/approvals/service';
import {
  checkScheduleIntent,
  schedulePost,
  type ScheduleInput,
} from '@/features/scheduling/service';
import { publishNow } from './service';

/**
 * Publishing a draft straight away, or scheduling it, without the review steps
 * — in a workspace for the agency's own accounts only (**D-127**).
 *
 * A post for a client goes through review because the client has to see it.
 * A post for AHN's own accounts has nobody to send it to, and D-106 already let
 * its author approve and schedule it themselves — two more clicks that decide
 * nothing. This takes the same three steps in one: submit for internal review,
 * approve, then schedule or publish now.
 *
 * ## A shortcut through the screens, never through the rules
 *
 * Each step is the existing one — `transitionPost`, `decideApproval`,
 * `schedulePost`, `publishNow` — so each is still authorised by the state
 * machine, re-validated, and audited, and the approval is recorded with its
 * decider like any other. Nobody can do here what they could not do in three
 * clicks: a Content Creator may approve and schedule their own post in an
 * internal workspace (D-106) but not publish now, and that is unchanged.
 *
 * ## All or nothing, as far as it can be
 *
 * The steps are separate transactions. So every condition that could stop a
 * later step is checked **before the first one is taken**: the workspace has no
 * client, the post is a draft, this person may take every step, and the time
 * is valid. A refusal leaves the post a draft. What can still fail part-way is
 * what nobody can know in advance — a race, an outage — and then the post stays
 * where it reached (in review, or approved), which is a real state the page
 * shows with its ordinary buttons.
 */

export type DirectPublishInput = { mode: 'now' } | { mode: 'schedule'; schedule: ScheduleInput };

/** The three moves, in order. */
const STEPS: ReadonlyArray<readonly [PostStatus, PostStatus]> = [
  ['DRAFT', 'INTERNAL_REVIEW'],
  ['INTERNAL_REVIEW', 'APPROVED'],
  ['APPROVED', 'SCHEDULED'],
];

const APPROVAL_NOTE =
  'Approved on publishing: posts for the agency’s own accounts have no review step.';

/**
 * Whether this principal could publish this post without review, and how.
 *
 * Shared by the page — so the buttons it shows are the ones the endpoint will
 * accept — and by the endpoint, which asks again.
 */
export function directPublishOptions(
  ctx: TenantContext,
  post: {
    status: PostStatus;
    workspaceId: string;
    brandId: string | null;
    createdById: string | null;
    requiresClientApproval: boolean;
  },
): { schedule: boolean; now: boolean } {
  // Only an explicit "no client" grants anything; anything else is a client's
  // workspace, whose posts go to review.
  if (post.requiresClientApproval !== false || post.status !== 'DRAFT') {
    return { schedule: false, now: false };
  }

  const scope: ResourceScope = {
    workspaceId: post.workspaceId,
    ...(post.brandId ? { brandId: post.brandId } : {}),
    createdById: post.createdById,
    requiresClientApproval: false,
  };

  const schedule = STEPS.every(([from, to]) =>
    canTransition(ctx, from, to, { ...scope, status: from }),
  );

  // Publishing now is its own right (docs/RBAC.md §4.4), on top of the steps.
  const now =
    schedule &&
    can(ctx, 'post:publish_now', { ...scope, status: 'APPROVED', intent: 'TRANSITION' });

  return { schedule, now };
}

export async function publishWithoutReview(
  ctx: TenantContext,
  postId: string,
  input: DirectPublishInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const post = await withTenant(ctx, (db) =>
    db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: {
        id: true,
        status: true,
        workspaceId: true,
        brandId: true,
        createdById: true,
        // A workspace that cannot be read keeps its client: "nobody needs to
        // see this" is never the answer by default.
        workspace: { select: { requiresClientApproval: true } },
      },
    }),
  );
  if (!post) throw new NotFoundError('Post');

  if (post.workspace?.requiresClientApproval !== false) {
    throw new ConflictError('Only an internal workspace publishes without review', {
      userMessage:
        'This post is for a client, so it goes to review first. Only posts for the agency’s own accounts can skip it.',
      context: { postId },
    });
  }

  if (post.status !== 'DRAFT') {
    throw new ConflictError('Only a draft can be published without review', {
      userMessage:
        'Only a draft can be published straight away. Use the buttons for where it is now.',
      context: { postId, status: post.status },
    });
  }

  const allowed = directPublishOptions(ctx, {
    status: post.status,
    workspaceId: post.workspaceId,
    brandId: post.brandId,
    createdById: post.createdById,
    requiresClientApproval: false,
  });

  if (input.mode === 'now' ? !allowed.now : !allowed.schedule) {
    throw new ForbiddenError('Not permitted to publish this post without review', {
      userMessage:
        input.mode === 'now'
          ? 'You can’t publish this post straight away. Schedule it, or ask an admin to publish it.'
          : 'You can’t schedule this post without review. Submit it for review instead.',
      context: { postId, mode: input.mode },
    });
  }

  // A time that would be refused at the last step is refused before the first.
  if (input.mode === 'schedule') {
    await checkScheduleIntent(ctx, postId, input.schedule);
  }

  // Validation and blocking tasks are checked by the first step, before it
  // changes anything. Neither intermediate step tells anybody: there is no
  // review to do, and the approval is this person's own.
  await transitionPost(ctx, postId, 'INTERNAL_REVIEW', fingerprint, {
    comment: 'Publishing without review (agency’s own accounts)',
    notify: false,
  });

  const gate = await withTenant(ctx, (db) =>
    db.approval.findFirst({
      where: { postId, stage: 'INTERNAL', state: 'PENDING' },
      orderBy: { requestedAt: 'desc' },
      select: { id: true },
    }),
  );
  if (!gate) {
    throw new ConflictError('The review gate for this post could not be found', {
      userMessage:
        'The post is now in review but could not be approved automatically. Approve it from the post.',
      context: { postId },
    });
  }

  await decideApproval(
    ctx,
    gate.id,
    { decision: 'APPROVED', comment: APPROVAL_NOTE },
    fingerprint,
    { notify: false },
  );

  return input.mode === 'now'
    ? publishNow(ctx, postId, fingerprint)
    : schedulePost(ctx, postId, input.schedule, fingerprint);
}
