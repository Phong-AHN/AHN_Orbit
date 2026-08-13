import { jsonOk } from '@/server/api-response';
import { withPlatformAdmin } from '@/server/with-platform-admin';
import { listJobs } from '@/features/admin/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The dead-letter browser (docs/API.md §2.13, SRS §28).
 *
 * Every entry is already safe to render: `recordDeadLetter` reduces the whole
 * cause chain through `describeFailure` before storing it, so what is held is a
 * sequence of error codes and vetted messages rather than a provider payload
 * (T1.11). Payloads carry identifiers only, never content or credentials.
 */
export const GET = withPlatformAdmin(
  { permission: 'admin:view_jobs', name: 'GET /api/v1/admin/jobs' },
  async ({ request }) => {
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? '');
    return jsonOk({
      jobs: await listJobs(Number.isFinite(limit) && limit > 0 ? limit : 50),
    });
  },
);
