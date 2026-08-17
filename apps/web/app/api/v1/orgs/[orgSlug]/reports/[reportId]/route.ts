import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { getReport } from '@/features/reports/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; reportId: string };

/**
 * One report's status.
 *
 * The id is not checked against this tenant here and does not need to be: the
 * lookup runs through the tenant-scoped client, so another organization's
 * report is simply not found — the same 404 an id that never existed produces,
 * which is what stops this confirming that it does.
 */
export const GET = withAuth<Params>(
  { permission: 'report:generate', name: 'GET /api/v1/orgs/{orgSlug}/reports/{reportId}' },
  async ({ ctx, params }) => jsonOk({ report: await getReport(ctx, params.reportId) }),
);
