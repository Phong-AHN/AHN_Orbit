import type { TenantContext } from '@orbit/core';
import type { ResourceScope } from '@orbit/rbac';
import { postScope } from './service';

/**
 * Resolve a post's authorization scope for `withAuth`.
 *
 * Every post route needs the same four facts before the policy engine can rule:
 * where the post lives (workspace, brand), who wrote it — which is what makes an
 * OWN-scoped grant work, so a Content Creator can edit their own drafts and no
 * one else's — and its current status, which is what enforces the edit lock.
 *
 * The lookup runs through the tenant-scoped client, so another organization's
 * post id is a 404 here, before any permission is even considered.
 */
export async function postResourceScope({
  params,
  ctx,
}: {
  params: { postId: string };
  ctx: TenantContext;
}): Promise<ResourceScope> {
  const post = await postScope(ctx, params.postId);
  return {
    workspaceId: post.workspaceId,
    brandId: post.brandId,
    createdById: post.createdById,
    status: post.status,
  };
}
