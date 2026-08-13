import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { postResourceScope } from '@/features/posts/route-scope';
import { listApprovalsForPost } from '@/features/approvals/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * A post's review history — the status timeline.
 *
 * There is deliberately no `POST` here. A review is requested by moving the post
 * into a review status, and `transitionPost` opens the gate in the same
 * transaction. A second endpoint that created approval rows directly would be a
 * way to queue a review without the state machine agreeing to it.
 */
export const GET = withAuth<Params>(
  {
    permission: 'post:read',
    resource: postResourceScope,
    name: 'GET /api/v1/orgs/{orgSlug}/posts/{postId}/approvals',
  },
  async ({ ctx, params }) => jsonOk({ approvals: await listApprovalsForPost(ctx, params.postId) }),
);
