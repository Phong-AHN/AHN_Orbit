import { ProviderRateLimitError, ProviderUnavailableError } from '@orbit/core';
import { logger } from '@orbit/observability';
import type { JobContext } from '@orbit/queue';
import { publishVariant } from '../publishing/engine.js';

/**
 * Job entry point for the publish queue.
 *
 * Thin by design: the engine holds the logic and takes no job, so all four
 * idempotency layers are testable without a queue in the way.
 *
 * Its one real responsibility is translating the engine's outcome into what the
 * queue layer should do next, and the translation is deliberately narrow:
 *
 *   • a **terminal** outcome returns normally. The engine has already recorded
 *     it; throwing would only make BullMQ re-run finished work.
 *   • a **deferred** outcome throws a retryable error, because re-enqueueing is
 *     the queue's job and `decideRetry` owns the backoff.
 *   • a **rate limit** throws `ProviderRateLimitError`, which the retry policy
 *     reschedules *without consuming an attempt* (T1.11).
 *
 * Nothing here can cause a second publish: by the time an outcome reaches this
 * function the claim has already been settled or released.
 */
export async function processPublish(job: JobContext<'publish'>): Promise<void> {
  const result = await publishVariant(job);

  switch (result.kind) {
    case 'PUBLISHED':
    case 'FAILED':
    case 'PARKED':
    case 'NOT_CLAIMABLE':
    case 'ALREADY_SETTLED':
      // Settled. The engine recorded the outcome; the job is done either way.
      return;

    case 'DEFERRED': {
      if (result.reason === 'RATE_LIMIT') {
        // Rescheduled at the provider's own figure, and the attempt budget is
        // untouched — a busy queue must not become a failed post.
        throw new ProviderRateLimitError('Account is over its publishing rate limit', {
          retryAfterSeconds: Math.ceil((result.requeueAfterMs ?? 60_000) / 1_000),
        });
      }

      // Everything else deferred — an account lock we could not take, or a
      // retryable provider error — comes back through the normal backoff.
      logger.info('publish deferred; will retry', {
        variantId: result.variantId,
        reason: result.reason,
      });

      throw new ProviderUnavailableError(result.reason ?? 'Publish deferred', {
        userMessage: 'We could not publish just now. We will try again shortly.',
      });
    }

    default: {
      const exhaustive: never = result.kind;
      throw new Error(`Unhandled publish outcome: ${String(exhaustive)}`);
    }
  }
}
