import { InvalidStateTransitionError } from './errors.js';
import type { ApprovalStage, ApprovalState, PostStatus } from './enums.js';

/**
 * Approval gate logic (SRS §15, docs/RBAC.md §5).
 *
 * Pure domain rules: which gate a status sits at, and which status a decision
 * leads to. No database, no request, no platform. The resulting status is then
 * fed through the *existing* post state machine rather than written directly,
 * so approvals cannot become a second, quieter way of moving a post.
 */

/** A decision a reviewer can record. `PENDING` is a state, not a decision. */
export type ApprovalDecision = Extract<ApprovalState, 'APPROVED' | 'CHANGES_REQUESTED'>;

export const APPROVAL_DECISIONS = [
  'APPROVED',
  'CHANGES_REQUESTED',
] as const satisfies readonly ApprovalDecision[];

/**
 * The gate a post is sitting at, or `null` if it is not awaiting anyone.
 *
 * This is the only mapping between post status and approval stage. Deriving it
 * in one place is what stops a post in `CLIENT_REVIEW` ever being answered by
 * an `INTERNAL` approval record.
 */
export function stageForStatus(status: PostStatus): ApprovalStage | null {
  switch (status) {
    case 'INTERNAL_REVIEW':
      return 'INTERNAL';
    case 'CLIENT_REVIEW':
      return 'CLIENT';
    default:
      return null;
  }
}

/**
 * Where a decision sends the post.
 *
 * The one subtlety is an internal approval: it finishes the review only when
 * the post does not also need the client's sign-off. When it does,
 * "approve" means "send it on to the client", which is why
 * `clientApprovalRequired` is an input rather than something inferred later.
 * docs/RBAC.md §5 records the same rule: `INTERNAL_REVIEW → APPROVED` is for
 * Acct Mgr, Admin and Owner *when client approval is not required*.
 */
export function statusAfterDecision(
  stage: ApprovalStage,
  decision: ApprovalDecision,
  clientApprovalRequired: boolean,
): PostStatus {
  if (decision === 'CHANGES_REQUESTED') return 'CHANGES_REQUESTED';

  if (stage === 'INTERNAL') {
    return clientApprovalRequired ? 'CLIENT_REVIEW' : 'APPROVED';
  }

  return 'APPROVED';
}

/**
 * Assert that an approval record actually answers the gate the post is at.
 *
 * Guards the case where a stale approval id — from an earlier round, or from
 * the other stage — is submitted against a post that has since moved on. The
 * post's status is the authority; the record is not.
 */
export function assertAnswersCurrentGate(
  postStatus: PostStatus,
  approvalStage: ApprovalStage,
  approvalState: ApprovalState,
): void {
  const gate = stageForStatus(postStatus);

  if (gate === null) {
    throw new InvalidStateTransitionError(postStatus, 'APPROVED', {
      userMessage: 'This post is not waiting for a decision right now.',
      context: { reason: 'post is not at an approval gate', approvalStage },
    });
  }

  if (gate !== approvalStage) {
    throw new InvalidStateTransitionError(postStatus, 'APPROVED', {
      userMessage: 'This post has moved on since that review was requested.',
      context: { reason: 'approval stage does not match the current gate', gate, approvalStage },
    });
  }

  if (approvalState !== 'PENDING') {
    throw new InvalidStateTransitionError(postStatus, 'APPROVED', {
      userMessage: 'That review has already been answered.',
      context: { reason: 'approval is no longer pending', approvalState },
    });
  }
}
