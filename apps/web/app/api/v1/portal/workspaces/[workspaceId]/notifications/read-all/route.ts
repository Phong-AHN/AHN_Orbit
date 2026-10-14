import { jsonOk } from '@/server/api-response';
import { withPortalAuth } from '@/server/with-portal-auth';
import { markAllReadForUser } from '@/features/notifications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { workspaceId: string };

/**
 * Clear the client's bell.
 *
 * **Audience-scoped, and this is the one place it has to be.** "All" here means
 * all of the rows this person was actually shown. Somebody who is a client of
 * one agency and staff at another would otherwise clear their agency inbox by
 * tidying up a client portal — marking read a set of notifications they were
 * never displayed and have not seen.
 *
 * Scoped to the caller as well, by the same rule as everything else here: the
 * `where` carries their user id. There is no body, so nothing a caller could
 * widen it with.
 */
export const POST = withPortalAuth<Params>(
  {
    permission: 'post:read',
    subject: ({ params }) => ({ kind: 'workspace', workspaceId: params.workspaceId }),
    name: 'POST /api/v1/portal/workspaces/{workspaceId}/notifications/read-all',
  },
  async ({ ctx }) => {
    const marked = await markAllReadForUser(ctx, 'CLIENT');
    return jsonOk({ marked, unread: 0 });
  },
);
