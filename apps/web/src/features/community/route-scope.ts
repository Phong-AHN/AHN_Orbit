import { NotFoundError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import type { ResourceScope } from '@orbit/rbac';

/**
 * Resolve a comment's authorization scope for `withAuth`.
 *
 * `comment:read_public` and `comment:reply` are **brand-scoped** for a Content
 * Creator and an Approver, so a route that declared a permission with no
 * resource would deny both of them outright — the same trap `canSomewhere`
 * exists for in navigation (**D-069**). The scope has to come from the row.
 *
 * No `createdById` and no `status`: neither grant is OWN-scoped or
 * status-restricted, and passing facts the policy engine will not consult
 * invites somebody to believe they are being checked.
 *
 * The lookup runs through the tenant-scoped client, so another organization's
 * comment id is a 404 here, before any permission is considered — and the
 * service re-resolves the same row for its own check, because a service must
 * not depend on a route having done it.
 */
export async function commentResourceScope({
  params,
  ctx,
}: {
  params: { commentId: string };
  ctx: TenantContext;
}): Promise<ResourceScope> {
  const comment = await withTenant(ctx, (db) =>
    db.socialComment.findFirst({
      where: { id: params.commentId },
      select: { workspaceId: true, brandId: true },
    }),
  );

  if (!comment) throw new NotFoundError('Comment');

  return { workspaceId: comment.workspaceId, brandId: comment.brandId };
}
