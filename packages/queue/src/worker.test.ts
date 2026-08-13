import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import {
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderValidationError,
  PublishingTimeoutError,
} from '@orbit/core';
import { runAttempt, assertWorkerProcess } from './worker.js';
import { causeChain } from './dead-letter.js';

/**
 * The attempt lifecycle, with the Redis-touching edges injected.
 *
 * `runAttempt` is separated from `startWorker` precisely so the retry and
 * dead-letter paths — the ones with real consequences — can be exercised
 * without infrastructure.
 */

const ORG = '018f0000-0000-7000-8000-000000000001';

function publishPayload(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    correlationId: 'corr-1',
    postVariantId: '018f0000-0000-7000-8000-000000000002',
    idempotencyKey: 'publish:v1:hash',
    publishingJobId: '018f0000-0000-7000-8000-000000000003',
    ...overrides,
  };
}

function harness() {
  const reenqueued: Array<{ payload: unknown; delayMs: number }> = [];
  const deadLettered: Array<Record<string, unknown>> = [];

  return {
    reenqueued,
    deadLettered,
    options: {
      reenqueue: async (payload: unknown, delayMs: number) => {
        reenqueued.push({ payload, delayMs });
      },
      deadLetter: async (entry: Record<string, unknown>) => {
        deadLettered.push(entry);
        return entry as never;
      },
    } as Parameters<typeof runAttempt>[4],
  };
}

describe('assertWorkerProcess', () => {
  const original = process.env.ORBIT_ROLE;

  afterEach(() => {
    if (original === undefined) delete process.env.ORBIT_ROLE;
    else process.env.ORBIT_ROLE = original;
  });

  it('refuses to start a consumer outside the worker process', () => {
    delete process.env.ORBIT_ROLE;
    expect(() => {
      assertWorkerProcess();
    }).toThrow(/ORBIT_ROLE/);
  });

  it('refuses when the role is the web app', () => {
    process.env.ORBIT_ROLE = 'web';
    expect(() => {
      assertWorkerProcess();
    }).toThrow(/apps\/worker/);
  });

  it('allows the worker process', () => {
    process.env.ORBIT_ROLE = 'worker';
    expect(() => {
      assertWorkerProcess();
    }).not.toThrow();
  });
});

describe('runAttempt', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports success and enqueues nothing', async () => {
    const { options, reenqueued, deadLettered } = harness();
    const processor = vi.fn().mockResolvedValue(undefined);

    const outcome = await runAttempt('publish', publishPayload(), 'job-1', processor, options);

    expect(outcome).toBe('SUCCEEDED');
    expect(processor).toHaveBeenCalledOnce();
    expect(reenqueued).toHaveLength(0);
    expect(deadLettered).toHaveLength(0);
  });

  it('hands the processor a parsed payload and the attempt number', async () => {
    const { options } = harness();
    const processor = vi.fn().mockResolvedValue(undefined);

    await runAttempt('publish', { ...publishPayload(), __attempt: 3 }, 'job-1', processor, options);

    expect(processor).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 3, jobId: 'job-1', correlationId: 'corr-1' }),
    );
  });

  it('re-enqueues a retryable failure with the scheduled backoff', async () => {
    const { options, reenqueued } = harness();
    const processor = vi.fn().mockRejectedValue(new ProviderUnavailableError('down'));

    const outcome = await runAttempt('publish', publishPayload(), 'job-1', processor, options);

    expect(outcome).toBe('RETRYING');
    expect(reenqueued).toHaveLength(1);
    expect(reenqueued[0]?.delayMs).toBe(30_000);
    expect(reenqueued[0]?.payload).toMatchObject({ __attempt: 2 });
  });

  it('advances the attempt number across retries', async () => {
    const { options, reenqueued } = harness();
    const processor = vi.fn().mockRejectedValue(new ProviderUnavailableError('down'));

    await runAttempt('publish', { ...publishPayload(), __attempt: 2 }, 'job-1', processor, options);

    expect(reenqueued[0]?.payload).toMatchObject({ __attempt: 3 });
    expect(reenqueued[0]?.delayMs).toBe(120_000);
  });

  it('reschedules a rate limit without consuming an attempt', async () => {
    const { options, reenqueued, deadLettered } = harness();
    const processor = vi
      .fn()
      .mockRejectedValue(new ProviderRateLimitError('slow', { retryAfterSeconds: 45 }));

    const outcome = await runAttempt(
      'publish',
      { ...publishPayload(), __attempt: 4 },
      'job-1',
      processor,
      options,
    );

    // Attempt 4 of 4 — a genuine failure would dead-letter here.
    expect(outcome).toBe('RESCHEDULED');
    expect(deadLettered).toHaveLength(0);
    expect(reenqueued[0]?.delayMs).toBe(45_000);
    expect(reenqueued[0]?.payload).toMatchObject({ __attempt: 4 });
  });

  it('dead-letters a non-retryable failure on the first attempt', async () => {
    const { options, reenqueued, deadLettered } = harness();
    const processor = vi.fn().mockRejectedValue(new ProviderValidationError('too long'));

    await expect(
      runAttempt('publish', publishPayload(), 'job-1', processor, options),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(reenqueued).toHaveLength(0);
    expect(deadLettered).toHaveLength(1);
    expect(deadLettered[0]).toMatchObject({
      queue: 'publish',
      jobId: 'job-1',
      organizationId: ORG,
      reason: 'NOT_RETRYABLE',
      attempts: 1,
    });
  });

  it('dead-letters once attempts are exhausted', async () => {
    const { options, deadLettered } = harness();
    const processor = vi.fn().mockRejectedValue(new ProviderUnavailableError('down'));

    await expect(
      runAttempt('publish', { ...publishPayload(), __attempt: 4 }, 'job-1', processor, options),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(deadLettered[0]).toMatchObject({ reason: 'ATTEMPTS_EXHAUSTED', attempts: 4 });
  });

  it('never re-enqueues an ambiguous publish', async () => {
    // The duplicate-publish guarantee. A timeout means the post may already
    // exist, so it goes to a human or the reconciler — never back on a timer.
    const { options, reenqueued, deadLettered } = harness();
    const processor = vi.fn().mockRejectedValue(new PublishingTimeoutError());

    await expect(
      runAttempt('publish', publishPayload(), 'job-1', processor, options),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(reenqueued).toHaveLength(0);
    expect(deadLettered[0]).toMatchObject({ reason: 'NEEDS_RECONCILIATION' });
  });

  it('dead-letters an unparseable payload without running the processor', async () => {
    const { options, reenqueued, deadLettered } = harness();
    const processor = vi.fn();

    await expect(
      runAttempt('publish', { nonsense: true }, 'job-1', processor, options),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    // A poison job must not reach provider code, and must not be retried four
    // times on a schedule when it can never succeed.
    expect(processor).not.toHaveBeenCalled();
    expect(reenqueued).toHaveLength(0);
    expect(deadLettered[0]).toMatchObject({ reason: 'NOT_RETRYABLE', organizationId: null });
  });

  it('respects a custom attempt ceiling', async () => {
    const { options, deadLettered } = harness();
    const processor = vi.fn().mockRejectedValue(new ProviderUnavailableError('down'));

    await expect(
      runAttempt('publish', { ...publishPayload(), __attempt: 2 }, 'job-1', processor, {
        ...options,
        maxAttempts: 2,
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(deadLettered[0]).toMatchObject({ reason: 'ATTEMPTS_EXHAUSTED' });
  });
});

describe('causeChain', () => {
  it('walks nested causes into safe frames', () => {
    const root = new Error('connect ECONNREFUSED 10.0.1.5:5432');
    const middle = new ProviderUnavailableError('graph unreachable', { cause: root });
    const top = new ProviderUnavailableError('publish failed', { cause: middle });

    const chain = causeChain(top);

    expect(chain).toHaveLength(3);
    expect(chain[0]?.code).toBe('PROVIDER_UNAVAILABLE');
    // The unknown root is reduced — its message names an internal host.
    expect(chain[2]?.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(chain)).not.toContain('10.0.1.5');
  });

  it('stops at the limit rather than following a cycle forever', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    // A deliberately cyclic chain.
    (a as Error & { cause?: unknown }).cause = b;

    expect(causeChain(b, 3)).toHaveLength(3);
  });

  it('handles an error with no cause', () => {
    expect(causeChain(new ProviderValidationError('nope'))).toHaveLength(1);
  });
});
