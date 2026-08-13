import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { postResourceScope } from '@/features/posts/route-scope';
import { duplicatePost } from '@/features/posts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * Copy a post into a fresh draft.
 *
 * Guarded by `post:create` rather than `post:read`: the result is a new post, so
 * whoever duplicates one must be allowed to author in that workspace. The scope
 * still comes from the source post, which is what confines the copy to the
 * workspace and brand the caller already has access to.
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:create',
    resource: postResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/posts/{postId}/duplicate',
  },
  async ({ request, ctx, params }) =>
    jsonOk(
      { post: await duplicatePost(ctx, params.postId, requestFingerprint(request)) },
      { status: 201 },
    ),
);
