import type { listApprovalsForPost } from '../service';
import type { ApprovalRecord } from './api';

/**
 * Convert approval rows into the shape the review panel receives.
 *
 * Explicit rather than a JSON round trip, for the same reason `serialisePost`
 * is: a server component can only hand a client component serialisable values,
 * and writing the mapping out means a new `Date` column becomes a type error
 * here rather than a runtime crash in the browser.
 */
export function serialiseApprovals(
  approvals: Awaited<ReturnType<typeof listApprovalsForPost>>,
): ApprovalRecord[] {
  return approvals.map((approval) => ({
    id: approval.id,
    postId: approval.postId,
    stage: approval.stage,
    state: approval.state,
    round: approval.round,
    comment: approval.comment,
    onBehalfOf: approval.onBehalfOf,
    requestedAt: approval.requestedAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    requestedBy: approval.requestedBy
      ? {
          id: approval.requestedBy.id,
          name: approval.requestedBy.name,
          email: approval.requestedBy.email,
        }
      : null,
    decidedBy: approval.decidedBy
      ? {
          id: approval.decidedBy.id,
          name: approval.decidedBy.name,
          email: approval.decidedBy.email,
        }
      : null,
  }));
}
