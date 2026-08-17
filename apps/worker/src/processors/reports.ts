import { REPORT_WORKER_CAPABILITIES } from '@orbit/auth';
import { logger } from '@orbit/observability';
import type { JobContext } from '@orbit/queue';
import { resolveTenantForJob } from '../context.js';
import { renderReport } from '../reports/render.js';

/**
 * Job entry point for the reports queue (T3.5).
 *
 * Thin, like the other processors. The one thing it owns is tenant derivation,
 * and it derives from the **report row** rather than from the payload
 * (**D-021**) — a payload that named another organization would be a way to
 * render one tenant's data into another tenant's file, which is the worst
 * shape this bug could take.
 */
export async function processReport(job: JobContext<'reports'>): Promise<void> {
  const { payload, correlationId } = job;

  const { ctx } = await resolveTenantForJob({
    queue: 'reports',
    jobId: job.jobId,
    claimedOrganizationId: payload.organizationId,
    subject: { subjectType: 'report', subjectId: payload.reportId },
    actorName: 'report-worker',
    capabilities: REPORT_WORKER_CAPABILITIES,
    correlationId,
  });

  const result = await renderReport({ ctx, reportId: payload.reportId, correlationId });

  if (result.kind === 'SKIPPED') {
    logger.debug('report render skipped', { reportId: payload.reportId, reason: result.reason });
  }
}
