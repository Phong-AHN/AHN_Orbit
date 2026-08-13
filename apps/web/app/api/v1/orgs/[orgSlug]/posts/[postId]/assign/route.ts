import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { assignPostSchema } from '@/features/posts/contracts';
import { postResourceScope } from '@/features/posts/route-scope';
import { assignPost } from '@/features/posts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * Hand a post to someone.
 *
 * The assignee is validated against organization membership in the service, so
 * a user id from outside the tenant is a 404 rather than a stored dangling
 * reference.
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:assign',
    resource: postResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/posts/{postId}/assign',
  },
  async ({ request, ctx, params }) => {
    const { assignedToId } = await readJsonBody(request, assignPostSchema);

    return jsonOk({
      post: await assignPost(ctx, params.postId, assignedToId, requestFingerprint(request)),
    });
  },
);
