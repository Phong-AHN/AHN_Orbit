import { jsonOk } from '@/server/api-response';
import { withPlatformAdmin } from '@/server/with-platform-admin';
import { getJob, isRetryableQueue } from '@/features/admin/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { jobId: string };

/**
 * One dead letter, with its full cause chain.
 *
 * `retryable` is computed here rather than left to the UI, so the button and the
 * endpoint agree about what is possible. A `publish` job reports `false`
 * (**D-045**) and so does one whose payload never parsed.
 */
export const GET = withPlatformAdmin<Params>(
  { permission: 'admin:view_jobs', name: 'GET /api/v1/admin/jobs/{jobId}' },
  async ({ params }) => {
    const job = await getJob(decodeURIComponent(params.jobId));

    return jsonOk({
      job,
      retryable: isRetryableQueue(job.queue) && job.payload !== undefined,
    });
  },
);
