import type { TenantContext } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { commentScope, resolveComment } from '@/features/comments/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; commentId: string };

async function scope({ params, ctx }: { params: Params; ctx: TenantContext }) {
  const post = await commentScope(ctx, params.commentId);
  return {
    workspaceId: post.workspaceId,
    brandId: post.brandId,
    createdById: post.createdById,
    status: post.status,
  };
}

/** Mark a review thread as dealt with. */
export const POST = withAuth<Params>(
  {
    permission: 'comment:resolve',
    resource: scope,
    name: 'POST /api/v1/orgs/{orgSlug}/comments/{commentId}/resolve',
  },
  async ({ request, ctx, params }) =>
    jsonOk({
      comment: await resolveComment(ctx, params.commentId, requestFingerprint(request)),
    }),
);
