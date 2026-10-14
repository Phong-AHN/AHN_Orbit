import { jsonOk } from '@/server/api-response';
import { withPortalAuth } from '@/server/with-portal-auth';
import { listForUser, unreadCountForUser } from '@/features/notifications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { workspaceId: string };

/**
 * A client's own notifications.
 *
 * ## Why the portal had none
 *
 * It was deliberate: the portal shows a client their brand and nothing of the
 * agency, and every affordance added to it is a chance to leak something that
 * belongs to the people who built it. A notification feed is a particularly
 * good way to do that, because a notification *pushes* its content at somebody
 * rather than waiting to be asked for.
 *
 * What changed is that the client's side of the review conversation genuinely
 * needed one. `post.client_review_requested` is the event — their gate opening
 * — and before it existed a client was never told that anything was waiting for
 * them. They found out by logging in and looking.
 *
 * ## Three narrowings, not one
 *
 * - **Identity.** Every query in `@orbit/notifications/read.ts` filters on the
 *   session principal's own user id, taken from the cookie and never from a
 *   parameter. There is no `notification:read` permission and there should not
 *   be one.
 * - **Tenant.** `withPortalAuth` derives the tenant from the workspace in the
 *   URL and confirms this person is a Client *of that workspace*, so the scoped
 *   client only ever sees one organization's rows.
 * - **Audience.** `CLIENT`, so an agency-side notification belonging to the
 *   same person — somebody who is staff at one agency and a client of another —
 *   cannot surface here in wording written for a colleague.
 *
 * `permission: 'post:read'` rather than something notification-shaped, for the
 * reason the approvals route gives: it is the permission that says this person
 * has a reason to be looking at this workspace at all.
 */
export const GET = withPortalAuth<Params>(
  {
    permission: 'post:read',
    subject: ({ params }) => ({ kind: 'workspace', workspaceId: params.workspaceId }),
    name: 'GET /api/v1/portal/workspaces/{workspaceId}/notifications',
  },
  async ({ request, ctx }) => {
    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get('unread') === 'true';
    const before = url.searchParams.get('before');
    const limit = Number(url.searchParams.get('limit') ?? '');

    const parsedBefore = before ? new Date(before) : undefined;

    const [page, unread] = await Promise.all([
      listForUser(ctx, 'CLIENT', {
        unreadOnly,
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        ...(parsedBefore && !Number.isNaN(parsedBefore.getTime()) ? { before: parsedBefore } : {}),
      }),
      unreadCountForUser(ctx, 'CLIENT'),
    ]);

    return jsonOk({ ...page, unread });
  },
);
