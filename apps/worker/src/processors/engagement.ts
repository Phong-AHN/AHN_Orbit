import { ENGAGEMENT_WORKER_CAPABILITIES } from '@orbit/auth';
import { logger } from '@orbit/observability';
import { enqueue, type JobContext } from '@orbit/queue';
import { resolveTenantForJob } from '../context.js';
import { ingestPostComments } from '../engagement/ingest.js';

/**
 * Job entry point for the engagement queue (SRS §22).
 *
 * Thin, like the other processors: the ingestion function holds the logic and
 * takes no job, so it can be exercised without a queue in the way.
 *
 * The capability set it runs under reads and cannot reply. A background job
 * that could speak as the brand is a background job that can post in public if
 * it is ever handed the wrong payload, and nothing here needs it — a reply goes
 * out from the request a person made.
 */
export async function processEngagement(job: JobContext<'engagement'>): Promise<void> {
  const { payload, correlationId } = job;

  if (!payload.postVariantId) {
    // The account-wide shape is not implemented yet: fanning out across every
    // recently published variant is the scheduler's job, and it enqueues one
    // job per variant. Refusing loudly rather than silently succeeding, so a
    // producer that sends the wrong shape is found rather than ignored.
    throw new Error('engagement jobs require a postVariantId');
  }

  // Tenant derivation follows D-021: the *subject row* is the authority on
  // which tenant this belongs to, and the payload's claim is compared against
  // it rather than trusted.
  const { ctx } = await resolveTenantForJob({
    queue: 'engagement',
    jobId: job.jobId,
    claimedOrganizationId: payload.organizationId,
    subject: { subjectType: 'postVariant', subjectId: payload.postVariantId },
    actorName: 'engagement-worker',
    capabilities: ENGAGEMENT_WORKER_CAPABILITIES,
    correlationId,
  });

  const result = await ingestPostComments({
    ctx,
    postVariantId: payload.postVariantId,
    correlationId,
    ...(payload.cursor ? { cursor: payload.cursor } : {}),
  });

  if (result.kind === 'SKIPPED') {
    logger.debug('comment ingestion skipped', {
      reason: result.reason,
      postVariantId: payload.postVariantId,
      socialAccountId: payload.socialAccountId,
    });
    return;
  }

  /**
   * A thread longer than one page continues as a new job rather than a loop.
   *
   * A `while` here would hold one worker slot for as long as a viral post has
   * comments, which is the shape that turns a popular post into an outage. The
   * continuation goes back through the queue, so it takes its turn behind other
   * tenants' work and inherits the same retry policy.
   */
  if (result.nextCursor) {
    await enqueue('engagement', {
      organizationId: ctx.organizationId,
      correlationId,
      socialAccountId: payload.socialAccountId,
      postVariantId: payload.postVariantId,
      cursor: result.nextCursor,
    });
  }

  logger.info('comment ingestion complete', {
    postVariantId: payload.postVariantId,
    created: result.created,
    updated: result.updated,
    continued: Boolean(result.nextCursor),
  });
}
