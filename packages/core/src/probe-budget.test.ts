import { describe, expect, it, vi } from 'vitest';
import { withProbeBudget } from './probe-budget.js';

/**
 * The deadline that turns a hanging health check into a reported one.
 *
 * Written after the real thing happened: the deep health endpoint on a
 * deployment whose database host had no reachable address sat for 90 seconds
 * and returned nothing, so the one request that could have named the broken
 * component was the one request that could not answer.
 */

describe('a probe that answers in time', () => {
  it('returns the value and does not report a timeout', async () => {
    const outcome = await withProbeBudget(async () => 'pong', 1_000);

    expect(outcome.timedOut).toBe(false);
    expect(outcome.value).toBe('pong');
  });

  /** A falsy answer is still an answer. `0` and `''` must not read as absent. */
  it('preserves a falsy result', async () => {
    expect(await withProbeBudget(async () => 0, 1_000)).toMatchObject({
      timedOut: false,
      value: 0,
    });
    expect(await withProbeBudget(async () => '', 1_000)).toMatchObject({
      timedOut: false,
      value: '',
    });
  });
});

describe('a probe that runs out of budget', () => {
  it('reports the timeout instead of waiting', async () => {
    const outcome = await withProbeBudget(
      () => new Promise((resolve) => setTimeout(() => resolve('too late'), 10_000)),
      40,
    );

    expect(outcome.timedOut).toBe(true);
    expect(outcome.value).toBeUndefined();
    // The whole point: it came back on the budget, not on the probe.
    expect(outcome.elapsedMs).toBeLessThan(2_000);
  });

  /**
   * **The dangerous case.** The abandoned probe is still running and will
   * reject later. Without the `catch` attached before the race, that rejection
   * lands with no handler and Node takes the process down — turning a reported
   * outage into a crashed server.
   */
  it('does not let the abandoned probe crash the process', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    const outcome = await withProbeBudget(
      () =>
        new Promise((_, reject) => setTimeout(() => reject(new Error('connect ETIMEDOUT')), 30)),
      10,
    );

    expect(outcome.timedOut).toBe(true);

    // Long enough for the abandoned rejection to fire and for Node to have
    // reported it if nothing were listening.
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
});

describe('a probe that fails fast', () => {
  /**
   * A refused connection is a real answer and must reach the caller as a
   * rejection, not be flattened into a timeout — "nothing is listening" and
   * "something is listening but never replies" send an operator to different
   * places.
   */
  it('propagates the rejection rather than reporting a timeout', async () => {
    await expect(
      withProbeBudget(async () => {
        throw new Error('ECONNREFUSED');
      }, 1_000),
    ).rejects.toThrow('ECONNREFUSED');
  });
});
