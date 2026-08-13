import { jsonOk } from '@/server/api-response';
import { withPortalAuth } from '@/server/with-portal-auth';
import { getPortalPost } from '@/features/portal/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { postId: string };

/**
 * One post, in the client's projection (docs/API.md §2.12).
 *
 * The workspace is not in the path — it comes from the post row, and the wrapper
 * then confirms the client belongs to it. A post id from another tenant, or from
 * a workspace this client is not in, resolves to a **404** before any of this
 * handler runs.
 *
 * A post that exists and is theirs but has not reached them — a `DRAFT`, an
 * `INTERNAL_REVIEW` — is also a 404, because the service's status narrowing is
 * part of the lookup rather than a check after it.
 */
export const GET = withPortalAuth<Params>(
  {
    permission: 'post:read',
    subject: ({ params }) => ({ kind: 'post', postId: params.postId }),
    name: 'GET /api/v1/portal/posts/{postId}',
  },
  async ({ ctx, params, workspaceId }) =>
    jsonOk(await getPortalPost(ctx, workspaceId, params.postId)),
);
