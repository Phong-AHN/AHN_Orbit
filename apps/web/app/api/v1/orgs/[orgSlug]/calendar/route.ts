import { accessibleWorkspaceIds, isUserPrincipal } from '@orbit/core';
import { CLIENT_VISIBLE_STATUSES } from '@orbit/rbac';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { calendarQuerySchema, parseCalendarDate } from '@/features/scheduling/contracts';
import { listCalendar } from '@/features/scheduling/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * The calendar (SRS §12).
 *
 * `timeZone` is the *display* zone — it decides which posts fall in "June" for
 * this viewer, and nothing else. What each post is scheduled for was settled in
 * the workspace's zone and stored in UTC (assumption C5).
 */
export const GET = withAuth<Params>(
  {
    permission: 'post:read',
    resource: ({ request }) => {
      const url = new URL(request.url);
      const workspaceId = url.searchParams.get('workspaceId');
      const brandId = url.searchParams.get('brandId');
      return {
        ...(workspaceId ? { workspaceId } : {}),
        ...(brandId ? { brandId } : {}),
      };
    },
    name: 'GET /api/v1/orgs/{orgSlug}/calendar',
  },
  async ({ request, ctx }) => {
    const url = new URL(request.url);

    const query = calendarQuerySchema.parse({
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      timeZone: url.searchParams.get('timeZone') ?? 'UTC',
      workspaceId: url.searchParams.get('workspaceId') ?? undefined,
      brandId: url.searchParams.get('brandId') ?? undefined,
      socialAccountId: url.searchParams.get('socialAccountId') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
    });

    // A Client sees only what has reached them, whatever the query asks for.
    const isClient = isUserPrincipal(ctx.principal) && ctx.principal.organizationRole === 'CLIENT';

    return jsonOk({
      posts: await listCalendar(ctx, {
        from: parseCalendarDate(query.from),
        to: parseCalendarDate(query.to),
        timeZone: query.timeZone,
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(query.brandId ? { brandId: query.brandId } : {}),
        ...(query.socialAccountId ? { socialAccountId: query.socialAccountId } : {}),
        ...(isClient
          ? { statuses: CLIENT_VISIBLE_STATUSES }
          : query.status
            ? { statuses: [query.status] }
            : {}),
        accessibleWorkspaces: accessibleWorkspaceIds(ctx),
      }),
    });
  },
);
