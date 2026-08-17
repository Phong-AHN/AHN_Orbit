import { ProviderRateLimitError } from '@orbit/core';
import { ANALYTICS_WORKER_CAPABILITIES } from '@orbit/auth';
import { logger } from '@orbit/observability';
import type { JobContext } from '@orbit/queue';
import { resolveTenantForJob } from '../context.js';
import { ingestAccountAnalytics, ingestPostAnalytics } from '../analytics/ingest.js';

/**
 * Job entry point for the analytics queue (T3.1).
 *
 * Thin, like the other processors: the ingestion functions hold the logic and
 * take no job, so they can be exercised without a queue in the way.
 *
 * The payload decides which of the two shapes this is — a `postVariantId` means
 * one published post's metrics, its absence means the account's day. Both are
 * routed here because they consume the same provider quota and belong on the
 * same concurrency limit.
 */
export async function processAnalytics(job: JobContext<'analytics'>): Promise<void> {
  const { payload, correlationId } = job;

  // Tenant derivation follows D-021: the *subject row* is the authority on
  // which tenant this belongs to, and the payload's claim is compared against
  // it rather than trusted.
  const { ctx } = await resolveTenantForJob({
    queue: 'analytics',
    jobId: job.jobId,
    claimedOrganizationId: payload.organizationId,
    subject: payload.postVariantId
      ? { subjectType: 'postVariant', subjectId: payload.postVariantId }
      : { subjectType: 'socialAccount', subjectId: payload.socialAccountId },
    actorName: 'analytics-worker',
    capabilities: ANALYTICS_WORKER_CAPABILITIES,
    correlationId,
  });

  const result = payload.postVariantId
    ? await ingestPostAnalytics({ ctx, postVariantId: payload.postVariantId, correlationId })
    : await ingestAccountAnalytics({
        ctx,
        socialAccountId: payload.socialAccountId,
        correlationId,
      });

  if (result.kind === 'SKIPPED') {
    logger.debug('analytics ingestion skipped', {
      reason: result.reason,
      socialAccountId: payload.socialAccountId,
      ...(payload.postVariantId ? { postVariantId: payload.postVariantId } : {}),
    });
  }
}

/**
 * Analytics is the queue that should yield.
 *
 * A rate limit here means the platform is busy, and the only thing waiting on
 * these numbers is a chart. Publishing shares the same app-level quota, so
 * spending retries on insights is spending them on a client's post going out
 * late. Rethrown as retryable so the queue's own policy reschedules it (D-020).
 */
export function isDeferrable(error: unknown): error is ProviderRateLimitError {
  return error instanceof ProviderRateLimitError;
}
