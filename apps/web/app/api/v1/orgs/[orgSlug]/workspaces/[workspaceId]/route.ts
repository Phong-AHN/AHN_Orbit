import { NextResponse } from 'next/server';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { updateWorkspaceSchema } from '@/features/tenancy/contracts';
import { deleteWorkspace, getWorkspace, updateWorkspace } from '@/features/tenancy/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; workspaceId: string };

/**
 * The `resource` callback runs after tenant resolution, so the workspace id it
 * passes to the policy engine is already confined to this organization. That is
 * what lets an Account Manager be scoped to their own workspaces without the
 * check being able to reach across tenants.
 */
const scope = ({ params }: { params: Params }) => ({ workspaceId: params.workspaceId });

export const GET = withAuth<Params>(
  {
    permission: 'workspace:read',
    resource: scope,
    name: 'GET /api/v1/orgs/{orgSlug}/workspaces/{workspaceId}',
  },
  async ({ ctx, params }) => jsonOk({ workspace: await getWorkspace(ctx, params.workspaceId) }),
);

export const PATCH = withAuth<Params>(
  {
    permission: 'workspace:update',
    resource: scope,
    name: 'PATCH /api/v1/orgs/{orgSlug}/workspaces/{workspaceId}',
  },
  async ({ request, ctx, params }) => {
    const patch = await readJsonBody(request, updateWorkspaceSchema);
    const workspace = await updateWorkspace(
      ctx,
      params.workspaceId,
      patch,
      requestFingerprint(request),
    );
    return jsonOk({ workspace });
  },
);

export const DELETE = withAuth<Params>(
  {
    permission: 'workspace:delete',
    resource: scope,
    name: 'DELETE /api/v1/orgs/{orgSlug}/workspaces/{workspaceId}',
  },
  async ({ request, ctx, params }) => {
    await deleteWorkspace(ctx, params.workspaceId, requestFingerprint(request));
    return new NextResponse(null, { status: 204 });
  },
);
