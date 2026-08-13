import { jsonOk } from '@/server/api-response';
import { readJsonBody } from '@/server/with-auth';
import { withPlatformAdmin } from '@/server/with-platform-admin';
import { platformAudit } from '@/server/platform-audit';
import { requestFingerprint } from '@/server/audit';
import { currentCorrelationId, logger } from '@orbit/observability';
import { discardJob, getJob } from '@/features/admin/service';
import { PROTECTED_ADMIN_FIELDS, adminActionSchema } from '@/features/admin/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { jobId: string };

/**
 * Drop a dead letter that has been dealt with.
 *
 * Audited on exactly the same terms as a retry, and for a sharper reason:
 * discarding is how an operational record *disappears*, so "who decided this
 * was fine, and why" is the question that will be asked afterwards.
 *
 * It removes the dead-letter entry only. The durable record of what happened to
 * a publish lives in `PublishingAttempt` and `PublishingJob` in Postgres, owned
 * by the tenant, and nothing here touches those.
 */
export const POST = withPlatformAdmin<Params>(
  { permission: 'admin:retry_job', name: 'POST /api/v1/admin/jobs/{jobId}/discard' },
  async ({ request, params, admin }) => {
    const { reason } = await readJsonBody(request, adminActionSchema, {
      alsoForbid: PROTECTED_ADMIN_FIELDS,
    });

    const jobId = decodeURIComponent(params.jobId);
    const entry = await getJob(jobId);

    if (entry.organizationId) {
      await platformAudit(admin, {
        organizationId: entry.organizationId,
        action: 'admin.job_discarded',
        resourceType: 'DeadLetterJob',
        // See the retry route: a dead-letter id is a Redis key, not a UUID.
        reason,
        before: {
          deadLetterId: jobId,
          queue: entry.queue,
          errorCode: entry.errorCode,
          attempts: entry.attempts,
        },
        ...requestFingerprint(request),
        ...(currentCorrelationId() ? { correlationId: currentCorrelationId() } : {}),
      });
    } else {
      logger.warn('platform admin discarded a job with no tenant', {
        securityEvent: true,
        adminUserId: admin.id,
        queue: entry.queue,
        deadLetterId: jobId,
        reason,
      });
    }

    return jsonOk({ discarded: await discardJob(jobId) });
  },
);
