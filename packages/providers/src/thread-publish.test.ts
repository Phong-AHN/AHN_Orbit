import { afterEach, describe, expect, it } from 'vitest';
import {
  ProviderUnavailableError,
  ProviderValidationError,
  fixedClock,
  setClock,
} from '@orbit/core';
import { continueThread, isThreadContinuation } from './thread-publish.js';
import type { ThreadProgress } from './thread.js';

/**
 * Pausing a thread between posts (D-124, 2026-11-19).
 *
 * A pause after progress is free — the engine continues at once without
 * spending a retry — so it must only ever follow a post that went live on the
 * same attempt. Otherwise a thread that never moves could pause forever.
 */

const start = Date.UTC(2026, 10, 19, 9, 0, 0);
let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

function ticking() {
  const clock = fixedClock(start);
  restore = setClock(clock);
  return clock;
}

const parts = ['one 1/4', 'two 2/4', 'three 3/4', 'four 4/4'];
const headOnly: ThreadProgress = { fingerprint: 'fp', total: 4, posted: [{ id: 'p-1' }] };

function run(overrides: Partial<Parameters<typeof continueThread>[0]> = {}) {
  const recorded: ThreadProgress[] = [];
  const promise = continueThread({
    platform: 'THREADS',
    label: 'Threads',
    parts,
    progress: headOnly,
    deadlineMs: start + 35_000,
    postReply: async ({ index }) => ({ id: `p-${index + 1}` }),
    record: async (progress) => {
      recorded.push(progress);
    },
    ...overrides,
  });
  return { promise, recorded };
}

describe('continueThread pausing', () => {
  it('pauses for free at the deadline once this attempt posted something', async () => {
    const clock = ticking();
    const { promise, recorded } = run({
      progressMade: true,
      postReply: async ({ index }) => {
        clock.advance(40_000);
        return { id: `p-${index + 1}` };
      },
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(isThreadContinuation(error)).toBe(true);
    expect((error as ProviderUnavailableError).userMessage).toBe(
      '2 of 4 posts in this thread are live on Threads. The rest are on their way.',
    );
    // Post 2 went out and was recorded before stopping.
    expect(recorded.at(-1)?.posted).toHaveLength(2);
  });

  it('counts the first post made on this attempt as progress', async () => {
    const clock = ticking();
    clock.advance(36_000); // the first post took the whole budget
    const { promise, recorded } = run({ progressMade: true });

    const error = await promise.catch((caught: unknown) => caught);
    expect(isThreadContinuation(error)).toBe(true);
    expect(recorded).toHaveLength(0);
  });

  it('stops as an ordinary retry when this attempt has posted nothing', async () => {
    const clock = ticking();
    clock.advance(36_000);
    const { promise } = run({ progressMade: false });

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(isThreadContinuation(error)).toBe(false);
  });

  it('pauses for free when the next post is still being prepared, after progress', async () => {
    ticking();
    const { promise } = run({
      progressMade: true,
      postReply: async () => {
        throw new ProviderUnavailableError('still preparing', {
          context: { stillPreparing: true },
        });
      },
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(isThreadContinuation(error)).toBe(true);
    expect((error as ProviderUnavailableError).context['threadPosted']).toBe(1);
  });

  it('keeps a still-preparing post a normal retry when nothing moved this attempt', async () => {
    ticking();
    const { promise } = run({
      progressMade: false,
      postReply: async () => {
        throw new ProviderUnavailableError('still preparing', {
          context: { stillPreparing: true },
        });
      },
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(isThreadContinuation(error)).toBe(false);
    expect((error as ProviderUnavailableError).retryable).toBe(true);
  });

  it('never turns a refusal into a pause', async () => {
    ticking();
    const { promise } = run({
      progressMade: true,
      postReply: async () => {
        throw new ProviderValidationError('refused', { context: { stillPreparing: true } });
      },
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(isThreadContinuation(error)).toBe(false);
    expect((error as ProviderValidationError).retryable).toBe(false);
  });

  it('finishes without pausing when there is time', async () => {
    ticking();
    const { promise, recorded } = run({ progressMade: true });
    const done = await promise;
    expect(done.posted.map((link) => link.id)).toEqual(['p-1', 'p-2', 'p-3', 'p-4']);
    expect(recorded).toHaveLength(3);
  });
});
