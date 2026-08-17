import { newCorrelationId } from '@orbit/core';
import { currentCorrelationId } from '@orbit/observability';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { createReportSchema } from '@/features/reports/contracts';
import { createReport, listReports } from '@/features/reports/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Reports for this organization (SRS §19, docs/API.md §2.9).
 *
 * The listing never carries a storage key — the service's select omits it, so
 * this route could not leak one even by serialising everything it was given.
 */
export const GET = withAuth<Params>(
  { permission: 'report:generate', name: 'GET /api/v1/orgs/{orgSlug}/reports' },
  async ({ ctx }) => jsonOk({ reports: await listReports(ctx) }),
);

/**
 * Ask for a report. Returns immediately with a queued row; the worker renders.
 *
 * `report:generate` rather than `report:export`: this creates the document.
 * Downloading it is the separate right, checked on the download route.
 */
export const POST = withAuth<Params>(
  {
    permission: 'report:generate',
    resource: async ({ request }) => {
      const body = await request
        .clone()
        .json()
        .catch(() => ({}));
      const workspaceId = (body as { workspaceId?: unknown }).workspaceId;
      return typeof workspaceId === 'string' ? { workspaceId } : {};
    },
    name: 'POST /api/v1/orgs/{orgSlug}/reports',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, createReportSchema);

    const report = await createReport(
      ctx,
      input,
      currentCorrelationId() ?? newCorrelationId(),
      requestFingerprint(request),
    );

    return jsonOk({ report }, { status: 201 });
  },
);
