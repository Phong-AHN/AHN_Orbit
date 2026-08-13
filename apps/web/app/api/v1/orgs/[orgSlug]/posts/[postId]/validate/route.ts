import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { postResourceScope } from '@/features/posts/route-scope';
import { validatePost } from '@/features/posts/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * The composer's source of truth for whether a post is publishable.
 *
 * It runs the same engine against the same capability descriptors the client
 * uses, so the two cannot disagree — and `/transition` re-runs it before letting
 * a post move forward, so a client that skipped this call gains nothing.
 *
 * POST rather than GET because it reads media, accounts and variants and is not
 * something to cache; it reports on state rather than changing it.
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:read',
    resource: postResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/posts/{postId}/validate',
  },
  async ({ ctx, params }) => jsonOk(await validatePost(ctx, params.postId)),
);
