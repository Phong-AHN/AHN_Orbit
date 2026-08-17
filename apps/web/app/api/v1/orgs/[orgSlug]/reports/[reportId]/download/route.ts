import { jsonOk } from '@/server/api-response';
import { requestFingerprint } from '@/server/audit';
import { withAuth } from '@/server/with-auth';
import { getReportDownloadUrl } from '@/features/reports/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; reportId: string };

/**
 * A short-lived signed URL for a finished report.
 *
 * **`report:export`, not `report:generate`.** Producing a document for internal
 * review and handing the file to somebody are different acts, and the matrix
 * already separates them — this is where that separation becomes real.
 *
 * The response carries a URL and an expiry, never a storage key. The URL is
 * good for five minutes and for one object.
 */
export const GET = withAuth<Params>(
  {
    permission: 'report:export',
    name: 'GET /api/v1/orgs/{orgSlug}/reports/{reportId}/download',
  },
  async ({ request, ctx, params }) => {
    const { url, expiresAt } = await getReportDownloadUrl(
      ctx,
      params.reportId,
      requestFingerprint(request),
    );

    return jsonOk({ url, expiresAt: expiresAt.toISOString() });
  },
);
