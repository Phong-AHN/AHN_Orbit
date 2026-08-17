import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { parseRange } from '@/features/analytics/range';
import { getAccountAnalytics } from '@/features/analytics/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; accountId: string };

/**
 * One account's day series (SRS §18, docs/API.md §2.9).
 *
 * The account id is not checked against this tenant here and does not need to
 * be: the query runs through the tenant-scoped client, so another
 * organization's account simply matches no rows. An empty series is the correct
 * answer to "show me an account you cannot see" — it says nothing about whether
 * that id exists, which a 404 would.
 */
export const GET = withAuth<Params>(
  {
    permission: 'analytics:read',
    resource: ({ request }) => {
      const workspaceId = new URL(request.url).searchParams.get('workspaceId');
      return workspaceId ? { workspaceId } : {};
    },
    name: 'GET /api/v1/orgs/{orgSlug}/analytics/accounts/{accountId}',
  },
  async ({ request, ctx, params }) => {
    const range = parseRange(new URL(request.url).searchParams);
    const series = await getAccountAnalytics(ctx, params.accountId, range);

    return jsonOk({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      series: series.map((row) => ({
        date: row.date.toISOString().slice(0, 10),
        metrics: row.metrics,
        // Sent alongside every point so the chart can label a gap rather than
        // draw it as a dip to zero (SRS §18).
        availability: row.availability,
        providerApiVersion: row.providerApiVersion,
      })),
    });
  },
);
