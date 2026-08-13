import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { postResourceScope } from '@/features/posts/route-scope';
import { getPublishingStatus } from '@/features/publishing/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * Per-account publishing state and the attempt history (SRS §14).
 *
 * The selected fields are the whitelist: a stable error code, the vetted
 * message, timings and the external ids. No credential, no raw provider
 * payload, no stack.
 */
export const GET = withAuth<Params>(
  {
    permission: 'post:read',
    resource: postResourceScope,
    name: 'GET /api/v1/orgs/{orgSlug}/posts/{postId}/publishing',
  },
  async ({ ctx, params }) => jsonOk(await getPublishingStatus(ctx, params.postId)),
);
