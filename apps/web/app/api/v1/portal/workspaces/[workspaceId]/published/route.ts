import { jsonOk } from '@/server/api-response';
import { withPortalAuth } from '@/server/with-portal-auth';
import { listPortalPublished } from '@/features/portal/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { workspaceId: string };

/**
 * What has gone live, with links to the real posts.
 *
 * Only variants that actually published are included, so a `PARTIALLY_PUBLISHED`
 * post shows the accounts it reached and stays silent about the one it did not.
 * That silence is deliberate: a variant parked in `NEEDS_REVIEW` (**D-027**) is
 * a question the agency has to answer before the client is asked to care.
 */
export const GET = withPortalAuth<Params>(
  {
    permission: 'post:read',
    subject: ({ params }) => ({ kind: 'workspace', workspaceId: params.workspaceId }),
    name: 'GET /api/v1/portal/workspaces/{workspaceId}/published',
  },
  async ({ ctx, workspaceId }) => jsonOk({ posts: await listPortalPublished(ctx, workspaceId) }),
);
