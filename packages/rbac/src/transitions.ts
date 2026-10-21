import {
  assertTransition,
  humanTransitionsFrom,
  isUserPrincipal,
  type PostStatus,
  type TenantContext,
  type TransitionRule,
} from '@orbit/core';
import { assertCan, can, type ResourceScope } from './policy.js';
import { isPermission } from './permissions.js';

/**
 * Bridges the domain state machine (@orbit/core) to the policy engine.
 *
 * The machine says which transitions exist and what permission each needs; the
 * policy engine says whether this principal holds it here. Neither knows about
 * the other, which keeps the domain rules and the access rules from growing
 * into one tangle.
 */

/**
 * The two moves an author may make on their own post in a workspace with no
 * client (**D-106**): approving it, and scheduling it.
 *
 * Nothing wider. Not `publish_now`, which is immediate and cannot be taken
 * back, and not any reopen or cancel, which the ordinary grants already
 * cover. The whole point is that an agency posting to its *own* accounts does
 * not stall waiting on a reviewer — and these two are exactly the steps it
 * would otherwise wait on.
 */
const AUTHOR_MAY_FINISH: ReadonlyArray<{ from: PostStatus; to: PostStatus }> = [
  { from: 'INTERNAL_REVIEW', to: 'APPROVED' },
  { from: 'APPROVED', to: 'SCHEDULED' },
];

/**
 * Whether the author of a post in an internal workspace may make this move
 * without the permission the transition table names for it.
 *
 * Four conditions, all required:
 *
 * 1. **The workspace is explicitly internal.** `requiresClientApproval` must be
 *    `false`, not merely absent — a caller that forgets to pass it gets the
 *    ordinary grants, never a wider one.
 * 2. **The move is one of the two above.**
 * 3. **The actor wrote the post.** Self-approval is the decision being made
 *    here, so it is limited to self.
 * 4. **They may still put work into review here.** Anchored on
 *    `post:submit_internal_review`, which is OWN-scoped for a Content Creator:
 *    it proves the author is still a member of the post's workspace, so
 *    somebody who has since left it cannot keep approving their old posts.
 *    This is exactly the boundary OWN already enforces, and no wider.
 *
 * Conditions 3 and 4 overlap **today**: the only role without
 * `post:approve_internal` is the Content Creator, whose submit grant is OWN and
 * so already implies authorship. Condition 3 is not decoration. It is what stops
 * a future change — a role given a workspace-wide submit grant, say — from
 * quietly turning "approve your own" into "approve anyone's". Exported so that
 * case can be tested directly; through the public API it is masked by the
 * ordinary grants of every role that has a broad submit today.
 */
export function authorMayFinish(
  ctx: TenantContext,
  from: PostStatus,
  to: PostStatus,
  resource: ResourceScope,
): boolean {
  if (resource.requiresClientApproval !== false) return false;
  if (!AUTHOR_MAY_FINISH.some((move) => move.from === from && move.to === to)) return false;
  if (!isUserPrincipal(ctx.principal)) return false;
  if (!resource.createdById || resource.createdById !== ctx.principal.userId) return false;

  return can(ctx, 'post:submit_internal_review', {
    ...resource,
    status: from,
    intent: 'TRANSITION',
  });
}

/**
 * Authorise a status change, or throw.
 *
 * Order matters: the machine is consulted first, so an illegal transition is a
 * 409 regardless of who asked and a system-only transition is refused even for
 * an Owner. A permission can therefore never unlock a transition that does not
 * exist.
 *
 * Returns the rule that was authorised, so a caller acting on the transition —
 * voiding approvals on a reopen, say — reads that from the machine rather than
 * re-deriving it from the status pair and drifting.
 */
export function assertTransitionAllowed(
  ctx: TenantContext,
  from: PostStatus,
  to: PostStatus,
  resource: ResourceScope = {},
): TransitionRule {
  const rule = assertTransition(from, to, 'HUMAN');

  if (rule.permission === null || !isPermission(rule.permission)) {
    throw new Error(
      `Transition ${from}→${to} names an unknown permission "${rule.permission}" — ` +
        'the state machine and the permission catalogue have drifted.',
    );
  }

  // Status constraints are evaluated against the *source* status: the question
  // is "may this principal act on a post that is currently in CLIENT_REVIEW?".
  //
  // `intent: 'TRANSITION'` exempts this from the edit lock — but only because
  // the machine has already ruled, one line above, that this transition exists
  // from this status. The reachable set is still the transition table's.
  // The machine has already confirmed this transition exists, so an author
  // finishing their own internal post is allowed past the grant check — and
  // only that. The transition table is still the only source of what is
  // reachable.
  if (authorMayFinish(ctx, from, to, resource)) return rule;

  assertCan(ctx, rule.permission, { ...resource, status: from, intent: 'TRANSITION' });

  return rule;
}

export function canTransition(
  ctx: TenantContext,
  from: PostStatus,
  to: PostStatus,
  resource: ResourceScope = {},
): boolean {
  try {
    assertTransitionAllowed(ctx, from, to, resource);
    return true;
  } catch {
    return false;
  }
}

/** Transitions this principal may actually perform here, for building the UI. */
export function allowedTransitions(
  ctx: TenantContext,
  from: PostStatus,
  resource: ResourceScope = {},
): PostStatus[] {
  return humanTransitionsFrom(from)
    .filter((rule) => canTransition(ctx, from, rule.to, resource))
    .map((rule) => rule.to);
}
