import { jsonOk } from '@/server/api-response';
import { readJsonBody } from '@/server/with-auth';
import { withPlatformAdmin } from '@/server/with-platform-admin';
import { platformAudit } from '@/server/platform-audit';
import { requestFingerprint } from '@/server/audit';
import { currentCorrelationId, logger } from '@orbit/observability';
import { getJob, isRetryableQueue, retryJob } from '@/features/admin/service';
import { PROTECTED_ADMIN_FIELDS, adminActionSchema } from '@/features/admin/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { jobId: string };

/**
 * Re-enqueue a dead-lettered job (docs/API.md §2.13; T1.18 DoD).
 *
 * This is the **only** endpoint on the admin surface that changes anything, and
 * everything about it is shaped by that:
 *
 *  • **A reason is mandatory.** Enforced by the zod contract and again by
 *    `assertReason`, so a second caller cannot skip it.
 *  • **The affected tenant's own audit log gets the row**, with the
 *    administrator named as the actor. The agency can see what we did to them
 *    and why — which is the whole point of docs/RBAC.md §1 rule 4.
 *  • **The audit is written before the retry.** If the audit fails, nothing
 *    happens; if the retry fails afterwards, the record says an attempt was
 *    made. An unaudited action is the outcome to avoid, not an unfulfilled one.
 *  • **`publish` is refused** (**D-045**) — publishing keeps exactly one door,
 *    and it is the tenant's own.
 */
export const POST = withPlatformAdmin<Params>(
  { permission: 'admin:retry_job', name: 'POST /api/v1/admin/jobs/{jobId}/retry' },
  async ({ request, params, admin }) => {
    const { reason } = await readJsonBody(request, adminActionSchema, {
      alsoForbid: PROTECTED_ADMIN_FIELDS,
    });

    const jobId = decodeURIComponent(params.jobId);

    // Resolved first so the audit row can name the tenant it belongs to, and so
    // a job that cannot be retried is refused before anything is recorded.
    const entry = await getJob(jobId);

    if (entry.organizationId) {
      await platformAudit(admin, {
        organizationId: entry.organizationId,
        action: 'admin.job_retried',
        resourceType: 'DeadLetterJob',
        // No `resourceId`: a dead-letter id is a Redis key, not a row id, and
        // `AuditLog.resourceId` is a UUID column. It goes in the snapshot.
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
      // Platform-wide work — a maintenance sweep, a scheduler pass — belongs to
      // no tenant, so there is no tenant audit log to write into. The security
      // log is the record instead, and it still names the actor and the reason.
      logger.warn('platform admin retried a job with no tenant', {
        securityEvent: true,
        adminUserId: admin.id,
        queue: entry.queue,
        deadLetterId: jobId,
        reason,
        retryable: isRetryableQueue(entry.queue),
      });
    }

    return jsonOk({ retried: await retryJob(jobId) });
  },
);
