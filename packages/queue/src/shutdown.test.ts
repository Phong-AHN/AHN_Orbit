import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isShuttingDown,
  installShutdownHandlers,
  resetShutdownState,
  shutdown,
} from './shutdown.js';
import type { RunningWorker } from './worker.js';

/**
 * Graceful shutdown.
 *
 * The behaviour that matters: a publish cut off mid-provider-call is the
 * ambiguous outcome the whole idempotency design exists to avoid, so draining
 * has to actually wait — and the deadline has to actually fire when it does not.
 */

vi.mock('./producer.js', () => ({ closeQueues: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./connection.js', () => ({
  closeSharedConnection: vi.fn().mockResolvedValue(undefined),
  isWorkerProcess: () => true,
}));

function fakeWorker(name: string, closeMs = 0): RunningWorker & { closed: boolean } {
  const worker = {
    name: name as RunningWorker['name'],
    closed: false,
    close: async () => {
      await new Promise((resolve) => setTimeout(resolve, closeMs));
      worker.closed = true;
    },
  };
  return worker;
}

describe('shutdown', () => {
  beforeEach(() => {
    resetShutdownState();
  });

  it('waits for in-flight jobs to drain', async () => {
    const slow = fakeWorker('publish', 40);

    await shutdown({ workers: [slow], graceMs: 5_000 });

    // The point of `close(false)`: it resolves only once the job finished.
    expect(slow.closed).toBe(true);
  });

  it('closes every worker', async () => {
    const workers = [fakeWorker('publish'), fakeWorker('media'), fakeWorker('notifications')];

    await shutdown({ workers, graceMs: 1_000 });

    expect(workers.every((w) => w.closed)).toBe(true);
  });

  it('gives up at the grace deadline rather than hanging forever', async () => {
    // A job that never finishes must not stop the process exiting — the
    // orchestrator would SIGKILL us anyway, and the job is safely reclaimed.
    const stuck: RunningWorker = {
      name: 'publish',
      close: () => new Promise<void>(() => {}),
    };

    const startedAt = Date.now();
    await shutdown({ workers: [stuck], graceMs: 60 });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('drains the other workers when one throws while closing', async () => {
    // One broken worker must not abort the whole shutdown: the others still
    // need to drain, and the connections still need closing. A half-finished
    // shutdown is how in-flight publishes get stranded.
    const broken: RunningWorker = {
      name: 'publish',
      close: () => Promise.reject(new Error('redis gone')),
    };
    const healthy = fakeWorker('media', 10);

    await expect(shutdown({ workers: [broken, healthy], graceMs: 5_000 })).resolves.toBeUndefined();

    expect(healthy.closed).toBe(true);
  });
});

describe('signal handling', () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    resetShutdownState();
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it('drains on the first signal and exits zero', async () => {
    const worker = fakeWorker('publish', 10);
    const exit = vi.fn();

    dispose = installShutdownHandlers({ workers: [worker], graceMs: 1_000, exit });

    expect(isShuttingDown()).toBe(false);
    process.emit('SIGTERM', 'SIGTERM');
    expect(isShuttingDown()).toBe(true);

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(worker.closed).toBe(true);
  });

  it('exits immediately on a second signal', async () => {
    // An operator pressing Ctrl-C twice should not have to wait out a long job.
    const stuck: RunningWorker = { name: 'publish', close: () => new Promise<void>(() => {}) };
    const exit = vi.fn();

    dispose = installShutdownHandlers({ workers: [stuck], graceMs: 60_000, exit });

    process.emit('SIGTERM', 'SIGTERM');
    process.emit('SIGTERM', 'SIGTERM');

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs an unhandled rejection instead of killing the process mid-job', async () => {
    const worker = fakeWorker('publish');
    const exit = vi.fn();

    dispose = installShutdownHandlers({ workers: [worker], graceMs: 1_000, exit });

    process.emit('unhandledRejection', new Error('stray'), Promise.resolve());

    // Killing the process here would abandon an in-flight publish; the job's
    // own error path is what decides the retry.
    expect(exit).not.toHaveBeenCalled();
  });
});
