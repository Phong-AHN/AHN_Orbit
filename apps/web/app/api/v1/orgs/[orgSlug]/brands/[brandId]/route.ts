import { NextResponse } from 'next/server';
import { withTenant } from '@orbit/db';
import { NotFoundError, type TenantContext } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { updateBrandSchema } from '@/features/tenancy/contracts';
import { deleteBrand, getBrand, updateBrand } from '@/features/tenancy/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; brandId: string };

/**
 * Brand-scoped permission checks need the brand's *workspace* too, since a
 * BRAND-scoped grant falls back to workspace membership when the brand has no
 * explicit assignments. That lookup runs through the tenant-scoped client, so
 * a brand id from another organization resolves to nothing and the check fails
 * closed with a 404.
 */
async function scope({ params, ctx }: { params: Params; ctx: TenantContext }) {
  const brand = await withTenant(ctx, (db) =>
    db.brand.findFirst({
      where: { id: params.brandId, deletedAt: null },
      select: { id: true, workspaceId: true },
    }),
  );

  if (!brand) throw new NotFoundError('Brand');
  return { brandId: brand.id, workspaceId: brand.workspaceId };
}

export const GET = withAuth<Params>(
  {
    permission: 'brand:read',
    resource: scope,
    name: 'GET /api/v1/orgs/{orgSlug}/brands/{brandId}',
  },
  async ({ ctx, params }) => jsonOk({ brand: await getBrand(ctx, params.brandId) }),
);

export const PATCH = withAuth<Params>(
  {
    permission: 'brand:update',
    resource: scope,
    name: 'PATCH /api/v1/orgs/{orgSlug}/brands/{brandId}',
  },
  async ({ request, ctx, params }) => {
    const patch = await readJsonBody(request, updateBrandSchema);
    const brand = await updateBrand(ctx, params.brandId, patch, requestFingerprint(request));
    return jsonOk({ brand });
  },
);

export const DELETE = withAuth<Params>(
  {
    permission: 'brand:delete',
    resource: scope,
    name: 'DELETE /api/v1/orgs/{orgSlug}/brands/{brandId}',
  },
  async ({ request, ctx, params }) => {
    await deleteBrand(ctx, params.brandId, requestFingerprint(request));
    return new NextResponse(null, { status: 204 });
  },
);
