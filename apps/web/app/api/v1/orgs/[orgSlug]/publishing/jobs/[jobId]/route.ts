import type { TenantContext } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { getPublishingJob, publishingJobScope } from '@/features/publishing/logs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; jobId: string };

async function scope({ params, ctx }: { params: Params; ctx: TenantContext }) {
  const post = await publishingJobScope(ctx, params.jobId);
  return {
    workspaceId: post.workspaceId,
    brandId: post.brandId,
    createdById: post.createdById,
    status: post.status,
  };
}

/**
 * One job with its full attempt chain (API §2.8).
 *
 * The chain is the story: which attempt timed out, which reconciled, what the
 * platform said each time. Every field is whitelisted at write time — no
 * credential and no raw provider response reaches storage, so none can reach
 * this response.
 */
export const GET = withAuth<Params>(
  {
    permission: 'post:read',
    resource: scope,
    name: 'GET /api/v1/orgs/{orgSlug}/publishing/jobs/{jobId}',
  },
  async ({ ctx, params }) => jsonOk({ job: await getPublishingJob(ctx, params.jobId) }),
);
