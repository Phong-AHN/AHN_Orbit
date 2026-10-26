import { NotFoundError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import type { ResourceScope } from '@orbit/rbac';

/**
 * The workspace and brand a brand id names, for the route's permission check
 * (**D-108**). Read through the scoped client, so another tenant's brand is not
 * found. The service checks again against the same row before it acts.
 */
export async function brandResourceScope({
  params,
  ctx,
}: {
  params: { brandId: string };
  ctx: TenantContext;
}): Promise<ResourceScope> {
  const brand = await withTenant(ctx, (db) =>
    db.brand.findFirst({
      where: { id: params.brandId, deletedAt: null },
      select: { workspaceId: true },
    }),
  );

  if (!brand) throw new NotFoundError('Brand');

  return { workspaceId: brand.workspaceId, brandId: params.brandId };
}
