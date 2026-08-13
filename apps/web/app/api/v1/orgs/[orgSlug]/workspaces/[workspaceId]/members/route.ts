import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { addWorkspaceMemberSchema } from '@/features/tenancy/contracts';
import { addWorkspaceMember, listWorkspaceMembers } from '@/features/tenancy/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; workspaceId: string };

const scope = ({ params }: { params: Params }) => ({ workspaceId: params.workspaceId });

export const GET = withAuth<Params>(
  {
    permission: 'workspace:read',
    resource: scope,
    name: 'GET /api/v1/orgs/{orgSlug}/workspaces/{workspaceId}/members',
  },
  async ({ ctx, params }) =>
    jsonOk({ members: await listWorkspaceMembers(ctx, params.workspaceId) }),
);

/**
 * Grant or change a workspace seat.
 *
 * `workspace:manage_members` gates the call; the service then enforces the
 * rules a permission cannot carry — an Account Manager may only staff their own
 * workspaces and only with client users, and a client can never hold an
 * internal workspace role (which would sidestep portal confinement).
 */
export const POST = withAuth<Params>(
  {
    permission: 'workspace:manage_members',
    resource: scope,
    name: 'POST /api/v1/orgs/{orgSlug}/workspaces/{workspaceId}/members',
  },
  async ({ request, ctx, params }) => {
    const { userId, role } = await readJsonBody(request, addWorkspaceMemberSchema);
    const membership = await addWorkspaceMember(
      ctx,
      params.workspaceId,
      userId,
      role,
      requestFingerprint(request),
    );
    return jsonOk({ membership }, { status: 201 });
  },
);
