import { ProviderUnavailableError } from '@orbit/core';
import { HEALTH_WORKER_CAPABILITIES } from '@orbit/auth';
import { logger } from '@orbit/observability';
import type { JobContext } from '@orbit/queue';
import { resolveTenantForJob } from '../context.js';
import { probeAccount } from '../health/probe.js';

/**
 * Job entry point for the account-health queue (T1.7).
 *
 * Thin, like the publish processor: the probe holds the logic and takes no job,
 * so it can be exercised without a queue in the way. What this function owns is
 * the tenant derivation and the translation of a probe outcome into what the
 * queue should do next.
 *
 * A rate-limited probe is thrown as a retryable error rather than swallowed,
 * because the retry policy is what knows how to reschedule it (T1.11, D-020).
 * Everything else is terminal: a verdict has been recorded, and re-running would
 * only spend another provider call to learn the same thing.
 */
export async function processAccountHealth(job: JobContext<'account-health'>): Promise<void> {
  const { payload, correlationId } = job;

  // ── Tenant derivation (decision D-021) ──────────────────────────────────────
  // The account row is the authority on which tenant this belongs to. The
  // payload's `organizationId` is compared, never trusted, and a mismatch is a
  // tenant-isolation security event that fails the job.
  const { ctx } = await resolveTenantForJob({
    queue: 'account-health',
    jobId: job.jobId,
    claimedOrganizationId: payload.organizationId,
    subject: { subjectType: 'socialAccount', subjectId: payload.socialAccountId },
    actorName: 'account-health-worker',
    capabilities: HEALTH_WORKER_CAPABILITIES,
    correlationId,
  });

  const result = await probeAccount({
    ctx,
    socialAccountId: payload.socialAccountId,
    correlationId,
  });

  switch (result.kind) {
    case 'PROBED':
      return;

    case 'SKIPPED':
      logger.debug('health probe skipped', {
        socialAccountId: payload.socialAccountId,
        reason: result.reason,
      });
      return;

    case 'DEFERRED':
      throw new ProviderUnavailableError('Health probe is over its rate limit', {
        retryAfterSeconds: Math.ceil(result.retryAfterMs / 1_000),
        userMessage: 'We could not check this account just now. We will try again shortly.',
      });

    default: {
      const exhaustive: never = result;
      throw new Error(`Unhandled probe outcome: ${String(exhaustive)}`);
    }
  }
}
