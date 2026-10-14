import { jsonOk } from '@/server/api-response';
import { withPortalAuth } from '@/server/with-portal-auth';
import { markReadForUser, unreadCountForUser } from '@/features/notifications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { workspaceId: string; notificationId: string };

/**
 * Mark one of the client's notifications read.
 *
 * Identity, not role — the same rule as the agency's equivalent. `markRead` is
 * an `updateMany` carrying the session's user id in its predicate, so another
 * person's row matches nothing and answers 404 rather than 403, which would
 * confirm it exists.
 *
 * The audience filter is not applied to the write, and does not need to be: a
 * client can only name a notification id they were shown, and marking one of
 * their own agency-side rows read would be harmless even if they guessed one.
 * The count that comes back *is* audience-scoped, because it is what the bell
 * in front of them displays.
 */
export const POST = withPortalAuth<Params>(
  {
    permission: 'post:read',
    subject: ({ params }) => ({ kind: 'workspace', workspaceId: params.workspaceId }),
    name: 'POST /api/v1/portal/workspaces/{workspaceId}/notifications/{notificationId}/read',
  },
  async ({ ctx, params }) => {
    await markReadForUser(ctx, params.notificationId);
    return jsonOk({ unread: await unreadCountForUser(ctx, 'CLIENT') });
  },
);
