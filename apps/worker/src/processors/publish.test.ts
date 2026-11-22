import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishingTimeoutError, THREAD_CONTINUES, ValidationError } from '@orbit/core';
import { decideRetry, MAX_ATTEMPTS } from '@orbit/queue';

// Never the real database: `.env` points at production.
vi.mock('../publishing/attempts.js', () => ({ recordNextAttempt: vi.fn() }));
vi.mock('../publishing/engine.js', () => ({
  publishVariant: vi.fn(),
  giveUpPublish: vi.fn(),
  CLAIM_HELD: 'CLAIM_HELD',
}));

const { recordNextAttempt } = await import('../publishing/attempts.js');
const { publishVariant, giveUpPublish } = await import('../publishing/engine.js');
const { processPublish } = await import('./publish.js');

/**
 * What the queue does with a deferred publish, and what is written down first.
 *
 * A thread that paused between posts after putting some live (D-124) must come
 * back within seconds and must not count against the four attempts — the
 * 2026-11-19 report was a five-post Threads thread paused after post 1 and
 * sent into the 30s → 2m → 8m backoff, able to end FAILED with its first post
 * live. Anything else deferred keeps the normal schedule.
 *
 * And a publish the queue gives up on is failed, not left "Scheduled" with no
 * job to run it (D-128, 2026-11-23).
 */

const payload = {
  organizationId: 'org-1',
  correlationId: 'corr-1',
  postVariantId: 'variant-1',
  idempotencyKey: 'key-1',
  publishingJobId: 'job-row-1',
};

const jobAt = (attempt: number) =>
  ({ payload, attempt, jobId: 'job-1', correlationId: 'corr-1' }) as never;

async function thrownFor(reason: string, requeueAfterMs?: number, attempt = 1) {
  vi.mocked(publishVariant).mockResolvedValueOnce({
    kind: 'DEFERRED',
    variantId: 'variant-1',
    reason,
    ...(requeueAfterMs !== undefined ? { requeueAfterMs } : {}),
  } as never);
  return processPublish(jobAt(attempt)).then(
    () => undefined,
    (error: unknown) => error,
  );
}

beforeEach(() => {
  vi.mocked(recordNextAttempt).mockReset();
  vi.mocked(giveUpPublish).mockReset();
});

describe('processPublish deferrals', () => {
  it('continues a paused thread in seconds, without consuming an attempt', async () => {
    const error = await thrownFor(THREAD_CONTINUES);

    for (const attempt of [1, MAX_ATTEMPTS]) {
      expect(decideRetry(error, attempt)).toEqual({
        action: 'RESCHEDULE',
        delayMs: 2_000,
        consumesAttempt: false,
        reason: 'CONTINUATION',
      });
    }
  });

  it('looks again at a held claim once it can be taken over, without spending an attempt', async () => {
    // 2026-11-22: a job that found the claim of a worker that had stopped
    // mid-publish exited quietly, and the variant stayed PUBLISHING for days.
    const error = await thrownFor('CLAIM_HELD', 14 * 60_000 + 30_000);

    expect(decideRetry(error, MAX_ATTEMPTS)).toEqual({
      action: 'RESCHEDULE',
      delayMs: 870_000,
      consumesAttempt: false,
      reason: 'CONTINUATION',
    });
  });

  it('keeps a retryable provider failure on the normal backoff', async () => {
    const error = await thrownFor('PROVIDER_UNAVAILABLE');
    expect(decideRetry(error, 1)).toMatchObject({ action: 'RETRY', consumesAttempt: true });
  });
});

describe('what is written down before the queue takes over (D-128)', () => {
  it('records when a deferred publish will run next', async () => {
    const before = Date.now();
    await thrownFor('PROVIDER_UNAVAILABLE', undefined, 1);

    expect(giveUpPublish).not.toHaveBeenCalled();
    const [jobRow, at] = vi.mocked(recordNextAttempt).mock.calls[0] ?? [];
    expect(jobRow).toBe('job-row-1');
    // The first backoff step: thirty seconds.
    expect((at as Date).getTime() - before).toBeGreaterThanOrEqual(30_000 - 50);
    expect((at as Date).getTime() - before).toBeLessThan(31_000);
  });

  it('fails the variant when the last attempt is spent, with the reason', async () => {
    await thrownFor('PROVIDER_UNAVAILABLE', undefined, MAX_ATTEMPTS);

    expect(recordNextAttempt).not.toHaveBeenCalled();
    expect(giveUpPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        postVariantId: 'variant-1',
        publishingJobId: 'job-row-1',
        organizationId: 'org-1',
        code: 'PROVIDER_UNAVAILABLE',
        message: expect.stringMatching(/^Publishing gave up after 4 attempts\./),
      }),
    );
  });

  it('never gives up on a continuation, even on the last attempt', async () => {
    await thrownFor(THREAD_CONTINUES, undefined, MAX_ATTEMPTS);
    expect(giveUpPublish).not.toHaveBeenCalled();
    expect(recordNextAttempt).toHaveBeenCalledTimes(1);
  });

  it('fails the variant on an error no retry can fix', async () => {
    vi.mocked(publishVariant).mockRejectedValueOnce(new ValidationError('broken row'));
    await expect(processPublish(jobAt(1))).rejects.toBeInstanceOf(ValidationError);

    expect(giveUpPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringMatching(/^Publishing could not continue\./),
      }),
    );
  });

  it('leaves an unknown outcome alone: that is for reconciliation, never a failure', async () => {
    vi.mocked(publishVariant).mockRejectedValueOnce(new PublishingTimeoutError());
    await expect(processPublish(jobAt(1))).rejects.toBeInstanceOf(PublishingTimeoutError);

    expect(giveUpPublish).not.toHaveBeenCalled();
    expect(recordNextAttempt).not.toHaveBeenCalled();
  });

  it('still hands the queue its error when the bookkeeping fails', async () => {
    vi.mocked(recordNextAttempt).mockRejectedValueOnce(new Error('database down'));
    const error = await thrownFor('PROVIDER_UNAVAILABLE');
    expect((error as { code?: string }).code).toBe('PROVIDER_UNAVAILABLE');
  });
});
