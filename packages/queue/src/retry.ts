import { isAppError, type AppError } from '@orbit/core';

/**
 * Retry policy (docs/ARCHITECTURE.md §5.2).
 *
 * The schedule is `30s → 2m → 8m → 30m`, four attempts. What decides whether an
 * attempt happens at all is the error taxonomy in `@orbit/core` — specifically
 * `AppError.retryable` — not a list of error names kept here. A new provider
 * error therefore gets correct retry behaviour by declaring `retryable` on
 * itself, with nothing to update in the queue layer.
 *
 * Three cases are not plain "retry or don't":
 *
 *   • **Rate limits** reschedule at the provider's `retryAfter` and do **not**
 *     consume an attempt. Burning the budget on a queue that was simply too
 *     busy would turn a delay into a failure.
 *   • **Timeouts** are non-retryable *here*. `PublishingTimeoutError` is
 *     ambiguous — the post may or may not exist — so the publish engine must
 *     reconcile before deciding (layer 4). Letting the queue retry it blindly is
 *     exactly the duplicate-publish path this design forbids.
 *   • **Unknown throws** are treated as retryable once. A bug that throws a
 *     plain `Error` is more often transient than not, and the dead-letter set
 *     catches it either way.
 */

export const BACKOFF_SCHEDULE_MS = [30_000, 120_000, 480_000, 1_800_000] as const;

export const MAX_ATTEMPTS = BACKOFF_SCHEDULE_MS.length;

export type RetryDecision =
  | { action: 'RETRY'; delayMs: number; consumesAttempt: true }
  | { action: 'RESCHEDULE'; delayMs: number; consumesAttempt: false; reason: 'RATE_LIMIT' }
  | { action: 'FAIL'; reason: RetryRefusal };

export type RetryRefusal =
  | 'NOT_RETRYABLE'
  | 'ATTEMPTS_EXHAUSTED'
  /** Ambiguous outcome — a human or the reconciler decides, never a blind retry. */
  | 'NEEDS_RECONCILIATION';

/** Backoff for an attempt number, 1-based. Clamped to the last step. */
export function backoffFor(attemptNumber: number): number {
  const index = Math.min(Math.max(attemptNumber, 1), BACKOFF_SCHEDULE_MS.length) - 1;
  return BACKOFF_SCHEDULE_MS[index] ?? BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1] ?? 0;
}

/**
 * Decide what happens after a failed attempt.
 *
 * `attemptNumber` is the attempt that just failed, 1-based.
 */
export function decideRetry(
  error: unknown,
  attemptNumber: number,
  maxAttempts: number = MAX_ATTEMPTS,
): RetryDecision {
  // An ambiguous publish must never be retried on a timer. The engine
  // reconciles with the provider first, or a human decides.
  if (isAppError(error) && error.code === 'PUBLISHING_TIMEOUT') {
    return { action: 'FAIL', reason: 'NEEDS_RECONCILIATION' };
  }

  if (isAppError(error) && error.code === 'PROVIDER_RATE_LIMIT') {
    // Honour the provider's own figure when it gave one; otherwise back off a
    // conservative minute rather than guessing shorter.
    const retryAfterMs = (error.retryAfterSeconds ?? 60) * 1_000;
    return {
      action: 'RESCHEDULE',
      delayMs: retryAfterMs,
      consumesAttempt: false,
      reason: 'RATE_LIMIT',
    };
  }

  if (!isRetryable(error)) {
    return { action: 'FAIL', reason: 'NOT_RETRYABLE' };
  }

  if (attemptNumber >= maxAttempts) {
    return { action: 'FAIL', reason: 'ATTEMPTS_EXHAUSTED' };
  }

  return { action: 'RETRY', delayMs: backoffFor(attemptNumber), consumesAttempt: true };
}

/**
 * Whether an error is worth trying again.
 *
 * An unrecognised throw counts as retryable: a bug that surfaces as a plain
 * `Error` is usually transient (a socket, a pool timeout), and the attempt cap
 * plus the dead-letter set bound the cost of being wrong.
 */
export function isRetryable(error: unknown): boolean {
  if (isAppError(error)) return error.retryable;
  return true;
}

/** The stable error code for a throw, for the job record and the logs. */
export function errorCodeOf(error: unknown): string {
  return isAppError(error) ? error.code : 'INTERNAL_ERROR';
}

/**
 * A safe, structured description of a failure.
 *
 * Only fields already deemed safe to surface. Provider payloads and headers are
 * never included — a Graph error body can carry a token fragment, and this
 * string ends up in the job record, the logs and the admin panel (SRS §14, §33).
 */
export function describeFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (isAppError(error)) {
    const appError: AppError = error;
    return {
      code: appError.code,
      // `userMessage` is the vetted one; `message` may name internals.
      message: appError.userMessage,
      retryable: appError.retryable,
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: 'The job failed unexpectedly.',
    retryable: true,
  };
}
