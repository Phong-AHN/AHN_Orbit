import {
  ProviderRateLimitError,
  ProviderUnavailableError,
  THREAD_CONTINUES,
  THREAD_CONTINUE_DELAY_MS,
  clock,
  presentFailure,
  type AppError,
} from '@orbit/core';
import { logError, logger } from '@orbit/observability';
import { decideRetry, errorCodeOf, type JobContext } from '@orbit/queue';
import { recordNextAttempt } from '../publishing/attempts.js';
import {
  CLAIM_HELD,
  giveUpPublish,
  publishVariant,
  type PublishRunResult,
} from '../publishing/engine.js';

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
 *   • a **thread continuing** — posts already live, the rest to follow —
 *     throws a continuation, rescheduled within seconds, also without
 *     consuming an attempt (D-124).
 *
 * Before any throw it writes down what the queue is about to do (D-128): when
 * the publish runs next, or — when the queue is about to give up — that it
 * failed. A deferred variant is `SCHEDULED` again by then, and one the queue
 * gave up on stayed "Scheduled" for ever with no job left to run it.
 *
 * Nothing here can cause a second publish: by the time an outcome reaches this
 * function the claim has already been settled or released.
 */
export async function processPublish(job: JobContext<'publish'>): Promise<void> {
  let result: PublishRunResult;
  try {
    result = await publishVariant(job);
  } catch (error) {
    await recordWhatHappensNext(job, error);
    throw error;
  }

  switch (result.kind) {
    case 'PUBLISHED':
    case 'FAILED':
    case 'PARKED':
    case 'NOT_CLAIMABLE':
    case 'ALREADY_SETTLED':
      // Settled. The engine recorded the outcome; the job is done either way.
      return;

    case 'DEFERRED': {
      const error = deferral(result);
      await recordWhatHappensNext(job, error, result.reason);
      throw error;
    }

    default: {
      const exhaustive: never = result.kind;
      throw new Error(`Unhandled publish outcome: ${String(exhaustive)}`);
    }
  }
}

/** The error that tells the queue how to come back to a deferred publish. */
function deferral(result: PublishRunResult): AppError {
  if (result.reason === 'RATE_LIMIT') {
    // Rescheduled at the provider's own figure, and the attempt budget is
    // untouched — a busy queue must not become a failed post.
    return new ProviderRateLimitError('Account is over its publishing rate limit', {
      retryAfterSeconds: Math.ceil((result.requeueAfterMs ?? 60_000) / 1_000),
    });
  }

  if (result.reason === CLAIM_HELD) {
    // Another run holds the claim. Looked at again once it can be taken
    // over — not an attempt, since nothing was tried.
    return new ProviderUnavailableError('Publish claim held by another run', {
      retryAfterSeconds: Math.ceil((result.requeueAfterMs ?? 60_000) / 1_000),
      context: { continuation: true, variantId: result.variantId },
    });
  }

  if (result.reason === THREAD_CONTINUES) {
    // Progress, not failure: the engine only defers this way after a post
    // went live this run, so the attempt budget is left alone and the next
    // part follows in seconds instead of after a backoff.
    return new ProviderUnavailableError('Thread continues in a new run', {
      retryAfterSeconds: Math.ceil(THREAD_CONTINUE_DELAY_MS / 1_000),
      context: { continuation: true, variantId: result.variantId },
    });
  }

  // Everything else deferred — an account lock we could not take, or a
  // retryable provider error — comes back through the normal backoff.
  logger.info('publish deferred; will retry', {
    variantId: result.variantId,
    reason: result.reason,
  });

  return new ProviderUnavailableError(result.reason ?? 'Publish deferred', {
    userMessage: 'We could not publish just now. We will try again shortly.',
  });
}

/**
 * Write down what the queue is about to do with this throw.
 *
 * Asks the same `decideRetry` the queue will, with the same attempt number:
 *
 *   • coming back — the time, as `nextAttemptAt`, so the stuck-job sweep can
 *     tell a publish that is waiting from one whose job is gone;
 *   • giving up — the variant failed with the last reason, so the post says
 *     so and offers a retry;
 *   • an outcome nobody knows — nothing: that is the engine's to park.
 *
 * Never masks the error it was given: a failure here is logged, and the
 * stuck-job sweep is the net for anything it could not write.
 */
async function recordWhatHappensNext(
  job: JobContext<'publish'>,
  error: unknown,
  code?: string,
): Promise<void> {
  const { payload } = job;
  const decision = decideRetry(error, job.attempt);

  try {
    if (decision.action !== 'FAIL') {
      await recordNextAttempt(payload.publishingJobId, new Date(clock.nowMs() + decision.delayMs));
      return;
    }

    if (decision.reason === 'NEEDS_RECONCILIATION') return;

    const failedCode = code ?? errorCodeOf(error);
    const why = presentFailure(failedCode).summary;
    await giveUpPublish({
      postVariantId: payload.postVariantId,
      publishingJobId: payload.publishingJobId,
      organizationId: payload.organizationId,
      correlationId: job.correlationId,
      code: failedCode,
      message:
        decision.reason === 'ATTEMPTS_EXHAUSTED'
          ? `Publishing gave up after ${job.attempt} attempts. ${why} Retry it once the problem is fixed.`
          : `Publishing could not continue. ${why} Retry it once the problem is fixed.`,
    });
  } catch (bookkeeping) {
    logError('could not record what happens next to a publish', bookkeeping, {
      variantId: payload.postVariantId,
      organizationId: payload.organizationId,
      decision: decision.action,
    });
  }
}
