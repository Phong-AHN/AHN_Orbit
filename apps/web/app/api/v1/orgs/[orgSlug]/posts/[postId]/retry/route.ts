import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { postResourceScope } from '@/features/posts/route-scope';
import { retryFailedVariants } from '@/features/publishing/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; postId: string };

/**
 * Retry the accounts that failed.
 *
 * Touches only `FAILED` variants: a published one must never be re-attempted,
 * and one parked as `NEEDS_REVIEW` is waiting on a human decision.
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:retry_failed',
    resource: postResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/posts/{postId}/retry',
  },
  async ({ request, ctx, params }) =>
    jsonOk(await retryFailedVariants(ctx, params.postId, requestFingerprint(request))),
);
