import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { PROTECTED_APPROVAL_FIELDS, decideApprovalSchema } from '@/features/approvals/contracts';
import { approvalScope, decideApproval } from '@/features/approvals/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; approvalId: string };

/**
 * Record a review decision.
 *
 * No `permission` is declared here for the same reason `/posts/{id}/transition`
 * declares none: which right applies depends on the gate and the decision —
 * `post:approve_internal`, `post:submit_client_review`, `post:approve_client`
 * and `post:request_changes` are four different things. The state machine names
 * the one that applies and RBAC enforces it inside `transitionPost`.
 */
export const POST = withAuth<Params>(
  { name: 'POST /api/v1/orgs/{orgSlug}/approvals/{approvalId}/decide' },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, decideApprovalSchema, {
      alsoForbid: PROTECTED_APPROVAL_FIELDS,
    });

    // Resolving first means another tenant's approval id is a 404 before any
    // decision logic runs, so this cannot be used to probe for ids.
    await approvalScope(ctx, params.approvalId);

    return jsonOk(await decideApproval(ctx, params.approvalId, input, requestFingerprint(request)));
  },
);
