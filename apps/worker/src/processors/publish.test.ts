import { describe, expect, it, vi } from 'vitest';
import { THREAD_CONTINUES } from '@orbit/core';
import { decideRetry, MAX_ATTEMPTS } from '@orbit/queue';

vi.mock('../publishing/engine.js', () => ({ publishVariant: vi.fn() }));

const { publishVariant } = await import('../publishing/engine.js');
const { processPublish } = await import('./publish.js');

/**
 * What the queue does with a deferred publish.
 *
 * A thread that paused between posts after putting some live (D-124) must come
 * back within seconds and must not count against the four attempts — the
 * 2026-11-19 report was a five-post Threads thread paused after post 1 and
 * sent into the 30s → 2m → 8m backoff, able to end FAILED with its first post
 * live. Anything else deferred keeps the normal schedule.
 */

const job = { payload: {}, attempt: 1, jobId: 'job-1', correlationId: 'corr-1' } as never;

async function thrownFor(reason: string) {
  vi.mocked(publishVariant).mockResolvedValueOnce({
    kind: 'DEFERRED',
    variantId: 'variant-1',
    reason,
  } as never);
  return processPublish(job).then(
    () => undefined,
    (error: unknown) => error,
  );
}

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

  it('keeps a retryable provider failure on the normal backoff', async () => {
    const error = await thrownFor('PROVIDER_UNAVAILABLE');
    expect(decideRetry(error, 1)).toMatchObject({ action: 'RETRY', consumesAttempt: true });
  });
});
