import {
  assertTransition,
  humanTransitionsFrom,
  type PostStatus,
  type TenantContext,
  type TransitionRule,
} from '@orbit/core';
import { assertCan, type ResourceScope } from './policy.js';
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
