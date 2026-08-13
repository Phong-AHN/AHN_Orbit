import { jsonOk } from '@/server/api-response';
import { readJsonBody } from '@/server/with-auth';
import { withPortalAuth } from '@/server/with-portal-auth';
import { requestFingerprint } from '@/server/audit';
import { decidePortalPost } from '@/features/portal/actions';
import { PROTECTED_PORTAL_FIELDS, portalDecisionSchema } from '@/features/portal/contracts';
import { requirePortalPost } from '@/features/portal/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { postId: string };

/**
 * The client's decision (docs/API.md §2.12).
 *
 * Two independent authorization steps, and both must pass:
 *
 *  1. **here** — `post:approve_client`, checked against the post's own workspace
 *     and brand *and* its current status, so the grant matrix's status
 *     restriction applies. A Client's grant does not reach a post that is not at
 *     `CLIENT_REVIEW`.
 *  2. **inside `decideApproval`** — the gate must answer the post's current
 *     status, and `transitionPost` then rules on the resulting move through the
 *     same state machine every other status change uses (**D-017**).
 *
 * Nothing here decides what a decision *means*. That lives in
 * `statusAfterDecision`, in the domain, in one place.
 */
export const POST = withPortalAuth<Params>(
  {
    permission: 'post:approve_client',
    subject: ({ params }) => ({ kind: 'post', postId: params.postId }),
    // The status matters: `post:approve_client` for a Client is restricted to
    // the statuses that have actually reached them.
    resource: async ({ params, ctx, workspaceId }) => {
      const post = await requirePortalPost(ctx, workspaceId, params.postId);
      return { workspaceId, brandId: post.brandId, status: post.status, intent: 'TRANSITION' };
    },
    name: 'POST /api/v1/portal/posts/{postId}/decide',
  },
  async ({ request, ctx, params, workspaceId }) => {
    const input = await readJsonBody(request, portalDecisionSchema, {
      alsoForbid: PROTECTED_PORTAL_FIELDS,
    });

    return jsonOk(
      await decidePortalPost(ctx, workspaceId, params.postId, input, requestFingerprint(request)),
    );
  },
);
