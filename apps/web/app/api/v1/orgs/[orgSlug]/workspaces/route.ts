import { accessibleWorkspaceIds } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { createWorkspaceSchema } from '@/features/tenancy/contracts';
import { createWorkspace, listWorkspaces } from '@/features/tenancy/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Workspaces the caller can reach.
 *
 * The permission check confirms they may read workspaces at all; the list is
 * then narrowed to their memberships, so an Account Manager sees their own
 * clients rather than every client of the agency.
 */
export const GET = withAuth<Params>(
  { permission: 'workspace:read', name: 'GET /api/v1/orgs/{orgSlug}/workspaces' },
  async ({ ctx }) => jsonOk({ workspaces: await listWorkspaces(ctx, accessibleWorkspaceIds(ctx)) }),
);

export const POST = withAuth<Params>(
  { permission: 'workspace:create', name: 'POST /api/v1/orgs/{orgSlug}/workspaces' },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, createWorkspaceSchema);
    const workspace = await createWorkspace(ctx, input, requestFingerprint(request));
    return jsonOk({ workspace }, { status: 201 });
  },
);
