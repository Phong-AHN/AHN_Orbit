import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  InternalError,
  ProviderAuthenticationError,
  ProviderMediaError,
  ProviderPermissionError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderValidationError,
  PublishingTimeoutError,
  ValidationError,
} from '@orbit/core';
import {
  BACKOFF_SCHEDULE_MS,
  MAX_ATTEMPTS,
  backoffFor,
  decideRetry,
  describeFailure,
  errorCodeOf,
  isRetryable,
} from './retry.js';

describe('backoff schedule', () => {
  it('follows the documented 30s → 2m → 8m → 30m', () => {
    expect(BACKOFF_SCHEDULE_MS).toEqual([30_000, 120_000, 480_000, 1_800_000]);
    expect(MAX_ATTEMPTS).toBe(4);
  });

  it('clamps below and above the schedule', () => {
    expect(backoffFor(0)).toBe(30_000);
    expect(backoffFor(1)).toBe(30_000);
    expect(backoffFor(4)).toBe(1_800_000);
    expect(backoffFor(99)).toBe(1_800_000);
  });
});

describe('retryability follows the error taxonomy', () => {
  it('retries what the taxonomy marks retryable', () => {
    expect(isRetryable(new ProviderUnavailableError('down'))).toBe(true);
    expect(isRetryable(new ProviderRateLimitError('slow down'))).toBe(true);
  });

  it('does not retry what the taxonomy marks final', () => {
    expect(isRetryable(new ProviderAuthenticationError('token dead'))).toBe(false);
    expect(isRetryable(new ProviderValidationError('too long'))).toBe(false);
    expect(isRetryable(new ProviderMediaError('bad image'))).toBe(false);
    expect(isRetryable(new ProviderPermissionError('no scope'))).toBe(false);
    expect(isRetryable(new ValidationError('nope'))).toBe(false);
    expect(isRetryable(new ConflictError('nope'))).toBe(false);
  });

  it('treats an unknown throw as retryable once', () => {
    // A plain Error is usually a socket or a pool timeout. The attempt cap and
    // the dead-letter set bound the cost of being wrong.
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
    expect(isRetryable('a string')).toBe(true);
  });
});

describe('decideRetry', () => {
  it('retries a retryable failure with the scheduled backoff', () => {
    expect(decideRetry(new ProviderUnavailableError('down'), 1)).toEqual({
      action: 'RETRY',
      delayMs: 30_000,
      consumesAttempt: true,
    });

    expect(decideRetry(new ProviderUnavailableError('down'), 3)).toEqual({
      action: 'RETRY',
      delayMs: 480_000,
      consumesAttempt: true,
    });
  });

  it('fails immediately on a non-retryable error, whatever the attempt', () => {
    expect(decideRetry(new ProviderValidationError('too long'), 1)).toEqual({
      action: 'FAIL',
      reason: 'NOT_RETRYABLE',
    });
  });

  it('fails once attempts are exhausted', () => {
    expect(decideRetry(new ProviderUnavailableError('down'), MAX_ATTEMPTS)).toEqual({
      action: 'FAIL',
      reason: 'ATTEMPTS_EXHAUSTED',
    });
  });

  it('reschedules a rate limit without consuming an attempt', () => {
    // Burning the attempt budget on a queue that was merely busy would turn a
    // delay into a failure.
    const decision = decideRetry(
      new ProviderRateLimitError('slow down', { retryAfterSeconds: 90 }),
      1,
    );

    expect(decision).toEqual({
      action: 'RESCHEDULE',
      delayMs: 90_000,
      consumesAttempt: false,
      reason: 'RATE_LIMIT',
    });
  });

  it('still reschedules a rate limit on the final attempt', () => {
    const decision = decideRetry(
      new ProviderRateLimitError('slow down', { retryAfterSeconds: 30 }),
      MAX_ATTEMPTS,
    );
    expect(decision.action).toBe('RESCHEDULE');
  });

  it('falls back to a conservative minute when the provider gave no retryAfter', () => {
    const decision = decideRetry(new ProviderRateLimitError('slow down'), 1);
    expect(decision).toMatchObject({ action: 'RESCHEDULE', delayMs: 60_000 });
  });

  it('never retries an ambiguous publish', () => {
    // The whole duplicate-publish guarantee rests on this: a timeout means the
    // post may already exist, so only reconciliation may decide (layer 4).
    for (const attempt of [1, 2, 3, 4]) {
      expect(decideRetry(new PublishingTimeoutError(), attempt)).toEqual({
        action: 'FAIL',
        reason: 'NEEDS_RECONCILIATION',
      });
    }
  });

  it('honours a custom attempt ceiling', () => {
    expect(decideRetry(new ProviderUnavailableError('down'), 2, 2)).toEqual({
      action: 'FAIL',
      reason: 'ATTEMPTS_EXHAUSTED',
    });
  });
});

describe('describeFailure', () => {
  it('reports the safe user message, never the internal one', () => {
    const error = new ProviderValidationError('Graph API said: (#100) Invalid parameter foo', {
      userMessage: "That post isn't valid for this platform.",
    });

    const described = describeFailure(error);
    expect(described.message).toBe("That post isn't valid for this platform.");
    expect(described.message).not.toContain('Graph API');
    expect(described.code).toBe('PROVIDER_VALIDATION_ERROR');
    expect(described.retryable).toBe(false);
  });

  it('does not leak an unknown error message', () => {
    // An unexpected throw's message is exactly the kind that names internals.
    const described = describeFailure(new Error('connect ECONNREFUSED 10.0.1.5:5432'));

    expect(described.message).toBe('The job failed unexpectedly.');
    expect(described.message).not.toContain('10.0.1.5');
    expect(described.code).toBe('INTERNAL_ERROR');
  });

  it('gives a stable code for the job record', () => {
    expect(errorCodeOf(new ProviderRateLimitError('x'))).toBe('PROVIDER_RATE_LIMIT');
    expect(errorCodeOf(new InternalError('x'))).toBe('INTERNAL_ERROR');
    expect(errorCodeOf('not an error')).toBe('INTERNAL_ERROR');
  });
});
