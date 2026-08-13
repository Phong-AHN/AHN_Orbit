import { logger } from '@orbit/observability';
import { closeSharedConnection } from './connection.js';
import { closeQueues } from './producer.js';
import type { RunningWorker } from './worker.js';

/**
 * Graceful shutdown (T1.11 DoD).
 *
 * ECS sends SIGTERM and then waits `stopTimeout` before SIGKILL. What we do
 * with that window matters more here than in a web service: a publish job cut
 * off mid-provider-call is exactly the ambiguous outcome the whole idempotency
 * design exists to avoid. So:
 *
 *   1. stop accepting new jobs immediately;
 *   2. let in-flight jobs finish;
 *   3. close Redis last, so step 2 can still write its results.
 *
 * A second signal is treated as "I mean it" and exits without waiting — an
 * operator pressing Ctrl-C twice should not have to wait out a 30-minute job.
 *
 * The hard deadline exists because a job that hangs must not stop the process
 * exiting; ECS would SIGKILL us anyway, and doing it ourselves at least logs
 * why. Jobs still running at that point are reclaimed by another worker after
 * `lockDuration` — safely, because layer 2's atomic claim means a reclaimed
 * publish finds the variant already taken.
 */

export interface ShutdownOptions {
  workers: RunningWorker[];
  /** Must be comfortably under the platform's SIGKILL timeout. */
  graceMs?: number;
  /** Injected in tests. */
  exit?: (code: number) => void;
}

const DEFAULT_GRACE_MS = 25_000;

let shuttingDown = false;

/** Exported for tests, which need a clean slate between cases. */
export function resetShutdownState(): void {
  shuttingDown = false;
}

export async function shutdown(options: ShutdownOptions): Promise<void> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const startedAt = Date.now();

  logger.info('shutdown started', { workers: options.workers.map((w) => w.name), graceMs });

  // `close(false)` stops taking new jobs and resolves once in-flight ones end.
  //
  // Each close is caught individually. One worker failing — Redis already gone,
  // say — must not abort the others' drain or skip the connection cleanup
  // below; a half-finished shutdown is how in-flight publishes get stranded.
  const drained = Promise.all(
    options.workers.map(async (worker) => {
      try {
        await worker.close();
      } catch (error) {
        logger.error('worker failed to close cleanly', {
          queue: worker.name,
          error: error instanceof Error ? error.message : String(error),
          note: 'its in-flight jobs will be reclaimed after the lock expires',
        });
      }
    }),
  );

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => {
      resolve('TIMEOUT');
    }, graceMs);
    // Never let the timer alone hold the process open.
    timer.unref?.();
  });

  const outcome = await Promise.race([drained.then(() => 'DRAINED' as const), deadline]);
  if (timer) clearTimeout(timer);

  if (outcome === 'TIMEOUT') {
    logger.error('shutdown grace period expired with jobs still in flight', {
      graceMs,
      note: 'in-flight jobs will be reclaimed by another worker after the lock expires',
    });
  }

  // Redis closes last: draining workers still need it to write results.
  await closeQueues().catch((error: unknown) => {
    logger.warn('failed to close queues cleanly', { error: String(error) });
  });
  await closeSharedConnection().catch((error: unknown) => {
    logger.warn('failed to close redis cleanly', { error: String(error) });
  });

  logger.info('shutdown complete', { outcome, durationMs: Date.now() - startedAt });
}

/**
 * Wire SIGTERM/SIGINT to a graceful shutdown.
 *
 * Returns a disposer so a test — or an embedding process — can unhook.
 */
export function installShutdownHandlers(options: ShutdownOptions): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const handle = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      // Second signal: the operator is telling us not to wait.
      logger.warn('second shutdown signal; exiting immediately', { signal });
      exit(1);
      return;
    }

    shuttingDown = true;
    logger.info('shutdown signal received', { signal });

    void shutdown(options)
      .then(() => {
        exit(0);
      })
      .catch((error: unknown) => {
        logger.error('shutdown failed', { error: String(error) });
        exit(1);
      });
  };

  process.on('SIGTERM', handle);
  process.on('SIGINT', handle);

  // A rejection nobody handled is a bug, but killing the process mid-publish is
  // worse than logging it: the job's own error path is what decides the retry.
  const onUnhandled = (reason: unknown) => {
    logger.error('unhandled rejection in worker', { error: String(reason) });
  };
  process.on('unhandledRejection', onUnhandled);

  return () => {
    process.off('SIGTERM', handle);
    process.off('SIGINT', handle);
    process.off('unhandledRejection', onUnhandled);
  };
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}
