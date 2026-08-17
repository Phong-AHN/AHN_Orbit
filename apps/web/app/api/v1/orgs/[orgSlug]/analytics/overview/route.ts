import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { parseRange } from '@/features/analytics/range';
import { getAnalyticsOverview } from '@/features/analytics/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Totals for a window (SRS §18, docs/API.md §2.9).
 *
 * `unavailable` is as important as `totals` and is not a footnote: a metric
 * that could not be summed everywhere is reported there and **left out of the
 * totals entirely**, so a partial sum can never be read as a complete one.
 */
export const GET = withAuth<Params>(
  {
    permission: 'analytics:read',
    resource: ({ request }) => {
      const workspaceId = new URL(request.url).searchParams.get('workspaceId');
      return workspaceId ? { workspaceId } : {};
    },
    name: 'GET /api/v1/orgs/{orgSlug}/analytics/overview',
  },
  async ({ request, ctx }) => {
    const params = new URL(request.url).searchParams;
    const range = parseRange(params);
    const workspaceId = params.get('workspaceId');

    return jsonOk({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      ...(await getAnalyticsOverview(ctx, range, {
        ...(workspaceId ? { workspaceId } : {}),
      })),
    });
  },
);
