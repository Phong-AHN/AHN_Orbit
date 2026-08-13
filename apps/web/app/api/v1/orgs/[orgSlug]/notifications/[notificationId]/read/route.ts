import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { markReadForUser, unreadCountForUser } from '@/features/notifications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; notificationId: string };

/**
 * Mark one notification read.
 *
 * No permission, for the reason given on the list route: this is identity, not
 * role. The update carries the session's user id in its `where`, so another
 * person's notification matches nothing and answers 404 — never 403, which
 * would confirm it exists.
 */
export const POST = withAuth<Params>(
  { name: 'POST /api/v1/orgs/{orgSlug}/notifications/{notificationId}/read' },
  async ({ ctx, params }) => {
    await markReadForUser(ctx, params.notificationId);
    return jsonOk({ unread: await unreadCountForUser(ctx) });
  },
);
