import type { TenantContext } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { publishingJobScope } from '@/features/publishing/logs';
import { retryPublishingJob } from '@/features/publishing/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; jobId: string };

async function scope({ params, ctx }: { params: Params; ctx: TenantContext }) {
  const post = await publishingJobScope(ctx, params.jobId);
  return {
    workspaceId: post.workspaceId,
    brandId: post.brandId,
    createdById: post.createdById,
    // A retry acts on a post past the edit lock by definition; it is a
    // publishing act, not a content edit (decision D-016).
    intent: 'TRANSITION' as const,
  };
}

/**
 * Retry one account's publish (API §2.8).
 *
 * Goes back through the *existing* engine rather than around it: the variant
 * returns to `SCHEDULED` at a new instant, which yields a new idempotency key,
 * and all four layers apply again. There is no path here that publishes
 * directly.
 *
 * Refused for a variant parked in `NEEDS_REVIEW` — that one needs a person to
 * establish what happened first, which is what `/resolve` is for.
 */
export const POST = withAuth<Params>(
  {
    permission: 'post:retry_failed',
    resource: scope,
    name: 'POST /api/v1/orgs/{orgSlug}/publishing/jobs/{jobId}/retry',
  },
  async ({ request, ctx, params }) =>
    jsonOk(await retryPublishingJob(ctx, params.jobId, requestFingerprint(request))),
);
