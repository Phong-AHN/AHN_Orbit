import { clock } from '@orbit/core';
import { jsonOk } from '@/server/api-response';
import { withPortalAuth } from '@/server/with-portal-auth';
import { listPortalCalendar } from '@/features/portal/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { workspaceId: string };

/** How far a single calendar request may span. Wider means a slow scan. */
const MAX_WINDOW_DAYS = 120;
const DEFAULT_WINDOW_DAYS = 30;

/**
 * The client's calendar (docs/API.md §2.12).
 *
 * `post:read` is checked against the workspace, and the service narrows to
 * `CLIENT_VISIBLE_STATUSES` regardless — the permission says a Client may read
 * posts, the query says which ones.
 */
export const GET = withPortalAuth<Params>(
  {
    permission: 'post:read',
    subject: ({ params }) => ({ kind: 'workspace', workspaceId: params.workspaceId }),
    name: 'GET /api/v1/portal/workspaces/{workspaceId}/calendar',
  },
  async ({ request, ctx, workspaceId }) => {
    const url = new URL(request.url);
    const now = clock.now();

    const from = parseDate(url.searchParams.get('from')) ?? now;
    const requestedTo = parseDate(url.searchParams.get('to'));

    const ceiling = new Date(from.getTime() + MAX_WINDOW_DAYS * 86_400_000);
    const fallback = new Date(from.getTime() + DEFAULT_WINDOW_DAYS * 86_400_000);

    // Clamped rather than rejected: a client fiddling with a URL should get a
    // sensible page, not an error about a limit they never saw.
    const to =
      requestedTo && requestedTo > from ? new Date(Math.min(+requestedTo, +ceiling)) : fallback;

    return jsonOk({
      from: from.toISOString(),
      to: to.toISOString(),
      posts: await listPortalCalendar(ctx, workspaceId, { from, to }),
    });
  },
);

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
