import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalError, ValidationError } from '@orbit/core';
import { logError, logger } from './logger.js';

/**
 * A 500 has to say what went wrong.
 *
 * `toAppError` wraps an unexpected throw in `InternalError('Unhandled error',
 * { cause })`, so the cause is the only record of the real failure. It was
 * attached and never logged, which made every unexpected production error
 * print the same line:
 *
 *   code: INTERNAL_ERROR, reason: "Unhandled error", errorContext: {}
 *
 * A dead Redis, a Prisma failure and a typo were indistinguishable, and an
 * incident began with nothing to go on.
 *
 * Asserted against the `logger` facade rather than stdout: pino captures its
 * destination when the module loads, so a spy on `process.stdout.write`
 * installed afterwards never sees the line.
 */

function lastPayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logError records the cause chain', () => {
  it('logs the real failure under an InternalError', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const root = new Error('connect ECONNREFUSED 10.0.0.1:6379');
    logError('request failed', new InternalError('Unhandled error', { cause: root }), {
      route: 'POST /publish-now',
    });

    const causes = lastPayload(spy).causes as Array<{ message: string; stack?: string }>;
    expect(causes[0]?.message).toBe('connect ECONNREFUSED 10.0.0.1:6379');
    // The stack of the *cause* is what points at the failing call.
    expect(causes[0]?.stack).toContain('connect ECONNREFUSED');
  });

  it('follows a nested chain', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const root = new Error('socket closed');
    const middle = new Error('queue unavailable', { cause: root });
    logError('request failed', new InternalError('Unhandled error', { cause: middle }));

    const causes = lastPayload(spy).causes as Array<{ message: string }>;
    expect(causes.map((c) => c.message)).toEqual(['queue unavailable', 'socket closed']);
  });

  /** A deliberate AppError has nothing underneath; the line stays clean. */
  it('omits the field entirely when there is no cause', () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    logError('request failed', new ValidationError('Post has no accounts to publish to'));

    expect(lastPayload(spy)).not.toHaveProperty('causes');
  });

  /**
   * A cycle logs each error **once**, not until the length bound trips.
   *
   * The bound alone already terminates, so this asserts the thing the bound
   * does not give: `a → b → a` yields `['a', 'b']` rather than
   * `['a', 'b', 'a', 'b']`. Repeated frames in an incident log are noise at
   * exactly the moment somebody is reading carefully.
   */
  it('logs each error once when the chain loops', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as Error & { cause?: unknown }).cause = b;

    logError('request failed', new InternalError('Unhandled error', { cause: a }));

    const causes = lastPayload(spy).causes as Array<{ message: string }>;
    expect(causes.map((c) => c.message)).toEqual(['a', 'b']);
  });

  /** And a genuinely deep chain is still cut off. */
  it('stops at four links on a long chain', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    let current = new Error('depth-0');
    for (let i = 1; i <= 8; i += 1) current = new Error(`depth-${i}`, { cause: current });

    logError('request failed', new InternalError('Unhandled error', { cause: current }));

    expect((lastPayload(spy).causes as unknown[]).length).toBe(4);
  });

  /** A thrown string is still worth recording. */
  it('records a non-Error cause', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    logError('request failed', new InternalError('Unhandled error', { cause: 'redis gone' }));

    const causes = lastPayload(spy).causes as Array<{ message: string }>;
    expect(causes[0]?.message).toBe('redis gone');
  });

  /**
   * The response stays generic even though the log is detailed. An unexpected
   * error's message is exactly the kind that leaks internals, which is why
   * `toAppError` replaces it — logging the cause must not undo that.
   */
  it('leaves the error’s own public message untouched', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const wrapped = new InternalError('Unhandled error', {
      cause: new Error('password=hunter2 at postgres://user:pw@host'),
    });
    logError('request failed', wrapped);

    expect(wrapped.message).toBe('Unhandled error');
    expect(lastPayload(spy).reason).toBe('Unhandled error');
  });
});
