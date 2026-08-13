import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { listForUser, unreadCountForUser } from '@/features/notifications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Your notifications (docs/API.md §2.11).
 *
 * **No `permission` on purpose.** There is no `notification:read` grant and
 * there should not be one — reading notifications is not a role's right, it is
 * an identity's. The service narrows every query on the session principal's own
 * user id, so an Owner sees their own bell and nobody else's. `withAuth` still
 * runs authentication and tenant resolution first, which is what makes that id
 * trustworthy (docs/RBAC.md §6).
 */
export const GET = withAuth<Params>(
  { name: 'GET /api/v1/orgs/{orgSlug}/notifications' },
  async ({ request, ctx }) => {
    const url = new URL(request.url);
    const unreadOnly = url.searchParams.get('unread') === 'true';
    const before = url.searchParams.get('before');
    const limit = Number(url.searchParams.get('limit') ?? '');

    const parsedBefore = before ? new Date(before) : undefined;

    const [page, unread] = await Promise.all([
      listForUser(ctx, {
        unreadOnly,
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        ...(parsedBefore && !Number.isNaN(parsedBefore.getTime()) ? { before: parsedBefore } : {}),
      }),
      unreadCountForUser(ctx),
    ]);

    return jsonOk({ ...page, unread });
  },
);
