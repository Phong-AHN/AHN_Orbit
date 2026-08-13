import { jsonOk } from '@/server/api-response';
import { withPortalAuth } from '@/server/with-portal-auth';
import { listPortalApprovals } from '@/features/portal/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { workspaceId: string };

/**
 * What is waiting on this client.
 *
 * The permission checked is `post:read`, not `post:approve_client`: seeing the
 * queue and answering it are different acts, and the decision endpoint checks
 * the second one for itself. A client who can read but not approve — a viewer
 * seat — still sees what their colleague needs to sign off.
 */
export const GET = withPortalAuth<Params>(
  {
    permission: 'post:read',
    subject: ({ params }) => ({ kind: 'workspace', workspaceId: params.workspaceId }),
    name: 'GET /api/v1/portal/workspaces/{workspaceId}/approvals',
  },
  async ({ ctx, workspaceId }) =>
    jsonOk({ approvals: await listPortalApprovals(ctx, workspaceId) }),
);
