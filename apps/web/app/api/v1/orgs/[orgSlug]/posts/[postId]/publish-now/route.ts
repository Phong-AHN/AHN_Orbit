import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { postResourceScope } from '@/features/posts/route-scope';
import { publishNow } from '@/features/publishing/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * Publish immediately.
 *
 * Guarded by `post:publish_now`, which docs/RBAC.md §4.4 restricts to Owner,
 * Admin and Account Manager — approvers approve, they do not publish, and that
 * separation of duties is the point of having an approval workflow at all.
 *
 * The service still routes the status change through the state machine, so a
 * post that has not been approved cannot be published by this door either.
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:publish_now',
    resource: postResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/posts/{postId}/publish-now',
  },
  async ({ request, ctx, params }) =>
    jsonOk(await publishNow(ctx, params.postId, requestFingerprint(request))),
);
