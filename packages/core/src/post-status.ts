import { InvalidStateTransitionError } from './errors.js';
import type { PostStatus } from './enums.js';

/**
 * The post lifecycle state machine (SRS §10, docs/RBAC.md §5).
 *
 * This table is the server's law. A transition absent from it is rejected
 * before it reaches the database, regardless of who asked — which is what
 * SRS §10's "users must not be able to arbitrarily change status through API
 * requests" requires structurally rather than by convention.
 *
 * Each rule names the *permission* it needs, not the roles that hold it.
 * Roles are @orbit/rbac's concern; keeping them out of here stops the domain
 * layer and the policy layer from drifting into each other.
 */

export type TransitionActor = 'HUMAN' | 'SYSTEM';

export interface TransitionRule {
  from: PostStatus;
  to: PostStatus;
  /** Permission the actor must hold. `null` for system-only transitions. */
  permission: string | null;
  actor: TransitionActor;
  /**
   * Reopening approved content invalidates the approvals that were granted for
   * the old content — otherwise a post could be approved, edited, and published
   * without anyone seeing what shipped.
   */
  voidsApprovals: boolean;
  description: string;
}

const rule = (
  from: PostStatus,
  to: PostStatus,
  permission: string | null,
  description: string,
  options: { actor?: TransitionActor; voidsApprovals?: boolean } = {},
): TransitionRule => ({
  from,
  to,
  permission,
  actor: options.actor ?? 'HUMAN',
  voidsApprovals: options.voidsApprovals ?? false,
  description,
});

export const TRANSITIONS: readonly TransitionRule[] = [
  rule('IDEA', 'DRAFT', 'post:update', 'Promote an idea into a working draft'),

  rule('DRAFT', 'INTERNAL_REVIEW', 'post:submit_internal_review', 'Submit for internal review'),

  rule(
    'INTERNAL_REVIEW',
    'CHANGES_REQUESTED',
    'post:request_changes',
    'Internal reviewer requests changes',
  ),
  rule(
    'INTERNAL_REVIEW',
    'CLIENT_REVIEW',
    'post:submit_client_review',
    'Send to the client for approval',
  ),
  rule(
    'INTERNAL_REVIEW',
    'APPROVED',
    'post:approve_internal',
    'Approve internally where client approval is not required',
  ),

  rule('CLIENT_REVIEW', 'CHANGES_REQUESTED', 'post:request_changes', 'Client requests changes'),
  rule('CLIENT_REVIEW', 'APPROVED', 'post:approve_client', 'Client approves'),

  rule(
    'CHANGES_REQUESTED',
    'DRAFT',
    'post:update',
    'Reopen for editing after changes were requested',
  ),

  rule('APPROVED', 'SCHEDULED', 'post:schedule', 'Schedule approved content'),
  rule('APPROVED', 'DRAFT', 'post:update', 'Reopen approved content for editing', {
    voidsApprovals: true,
  }),

  rule('SCHEDULED', 'DRAFT', 'post:update', 'Pull back from the schedule to edit', {
    voidsApprovals: true,
  }),

  // ── System-only. No human role may write these, not even an Owner. ─────────
  rule('SCHEDULED', 'PUBLISHING', null, 'Worker claims the post for publishing', {
    actor: 'SYSTEM',
  }),
  rule('PUBLISHING', 'PUBLISHED', null, 'Every target succeeded', { actor: 'SYSTEM' }),
  rule('PUBLISHING', 'PARTIALLY_PUBLISHED', null, 'Some targets succeeded, some failed', {
    actor: 'SYSTEM',
  }),
  rule('PUBLISHING', 'FAILED', null, 'Every target failed', { actor: 'SYSTEM' }),

  rule('FAILED', 'SCHEDULED', 'post:retry_failed', 'Retry a failed publish'),
  rule('PARTIALLY_PUBLISHED', 'SCHEDULED', 'post:retry_failed', 'Retry the targets that failed'),

  // `any → CANCELED` from SRS §10, expanded so the table stays explicit.
  ...(
    [
      'IDEA',
      'DRAFT',
      'INTERNAL_REVIEW',
      'CLIENT_REVIEW',
      'CHANGES_REQUESTED',
      'APPROVED',
      'SCHEDULED',
      'FAILED',
      'PARTIALLY_PUBLISHED',
    ] as const
  ).map((from) => rule(from, 'CANCELED', 'post:cancel_scheduled', 'Cancel the post')),
];

/** Statuses only the publishing worker may write (docs/RBAC.md §5). */
export const SYSTEM_WRITTEN_STATUSES = [
  'PUBLISHING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'FAILED',
] as const satisfies readonly PostStatus[];

/** Statuses with no outgoing transitions. Duplicate the post to start again. */
export const TERMINAL_STATUSES = ['PUBLISHED', 'CANCELED'] as const satisfies readonly PostStatus[];

/**
 * Content is frozen from APPROVED onward. Editing approved content silently
 * would defeat the approval, so an explicit reopen (which voids approvals) is
 * the only way back to an editable state.
 */
export const EDIT_LOCKED_STATUSES = [
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'CANCELED',
] as const satisfies readonly PostStatus[];

const index = new Map<string, TransitionRule>(TRANSITIONS.map((t) => [`${t.from}→${t.to}`, t]));

export function findTransition(from: PostStatus, to: PostStatus): TransitionRule | undefined {
  return index.get(`${from}→${to}`);
}

export function canTransition(from: PostStatus, to: PostStatus): boolean {
  return index.has(`${from}→${to}`);
}

/** Every transition legal from a status, for building UI affordances. */
export function transitionsFrom(from: PostStatus): TransitionRule[] {
  return TRANSITIONS.filter((t) => t.from === from);
}

/** Transitions a human may request, for building UI affordances. */
export function humanTransitionsFrom(from: PostStatus): TransitionRule[] {
  return transitionsFrom(from).filter((t) => t.actor === 'HUMAN');
}

export function isSystemWritten(status: PostStatus): boolean {
  return (SYSTEM_WRITTEN_STATUSES as readonly PostStatus[]).includes(status);
}

export function isTerminal(status: PostStatus): boolean {
  return (TERMINAL_STATUSES as readonly PostStatus[]).includes(status);
}

export function isEditLocked(status: PostStatus): boolean {
  return (EDIT_LOCKED_STATUSES as readonly PostStatus[]).includes(status);
}

/**
 * Resolve a requested transition, or throw.
 *
 * `actor` defaults to HUMAN: a caller must opt in to SYSTEM explicitly, so an
 * API path can never reach a system-only transition by accident.
 */
export function assertTransition(
  from: PostStatus,
  to: PostStatus,
  actor: TransitionActor = 'HUMAN',
): TransitionRule {
  const found = findTransition(from, to);

  if (!found) {
    throw new InvalidStateTransitionError(from, to, {
      context: { legalTargets: transitionsFrom(from).map((t) => t.to) },
    });
  }

  if (found.actor === 'SYSTEM' && actor !== 'SYSTEM') {
    throw new InvalidStateTransitionError(from, to, {
      userMessage: 'That status is set automatically while publishing and cannot be changed here.',
      context: { reason: 'system-only transition requested by a human actor' },
    });
  }

  return found;
}
