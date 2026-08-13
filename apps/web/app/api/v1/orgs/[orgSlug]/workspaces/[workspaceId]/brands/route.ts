import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { createBrandSchema } from '@/features/tenancy/contracts';
import { createBrand, getWorkspace } from '@/features/tenancy/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; workspaceId: string };

const scope = ({ params }: { params: Params }) => ({ workspaceId: params.workspaceId });

export const GET = withAuth<Params>(
  {
    permission: 'brand:read',
    resource: scope,
    name: 'GET /api/v1/orgs/{orgSlug}/workspaces/{workspaceId}/brands',
  },
  async ({ ctx, params }) => {
    const workspace = await getWorkspace(ctx, params.workspaceId);
    return jsonOk({ brands: workspace.brands });
  },
);

export const POST = withAuth<Params>(
  {
    permission: 'brand:create',
    resource: scope,
    name: 'POST /api/v1/orgs/{orgSlug}/workspaces/{workspaceId}/brands',
  },
  async ({ request, ctx, params }) => {
    const input = await readJsonBody(request, createBrandSchema);
    const brand = await createBrand(ctx, params.workspaceId, input, requestFingerprint(request));
    return jsonOk({ brand }, { status: 201 });
  },
);
