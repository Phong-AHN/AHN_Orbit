import { jsonOk } from '@/server/api-response';
import { readJsonBody } from '@/server/with-auth';
import { withPortalAuth } from '@/server/with-portal-auth';
import { requestFingerprint } from '@/server/audit';
import { commentOnPortalPost } from '@/features/portal/actions';
import { PROTECTED_PORTAL_FIELDS, portalCommentSchema } from '@/features/portal/contracts';
import { listPortalComments, requirePortalPost } from '@/features/portal/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { postId: string };

/**
 * Client-visible comments on a post.
 *
 * The read narrows to `CLIENT_VISIBLE` in the `where`, so an internal comment is
 * never loaded — there is no filtered-afterwards step for a refactor to drop.
 * The write is forced to `CLIENT_VISIBLE` by `createComment`, and a body that
 * tries to set `visibility` is a logged 400 rather than a silent correction.
 */
export const GET = withPortalAuth<Params>(
  {
    permission: 'post:read',
    subject: ({ params }) => ({ kind: 'post', postId: params.postId }),
    name: 'GET /api/v1/portal/posts/{postId}/comments',
  },
  async ({ ctx, params, workspaceId }) =>
    jsonOk({ comments: await listPortalComments(ctx, workspaceId, params.postId) }),
);

export const POST = withPortalAuth<Params>(
  {
    permission: 'comment:create',
    subject: ({ params }) => ({ kind: 'post', postId: params.postId }),
    resource: async ({ params, ctx, workspaceId }) => {
      const post = await requirePortalPost(ctx, workspaceId, params.postId);
      return { workspaceId, brandId: post.brandId, status: post.status };
    },
    name: 'POST /api/v1/portal/posts/{postId}/comments',
  },
  async ({ request, ctx, params, workspaceId }) => {
    const input = await readJsonBody(request, portalCommentSchema, {
      alsoForbid: PROTECTED_PORTAL_FIELDS,
    });

    return jsonOk(
      {
        comment: await commentOnPortalPost(
          ctx,
          workspaceId,
          params.postId,
          input,
          requestFingerprint(request),
        ),
      },
      { status: 201 },
    );
  },
);
