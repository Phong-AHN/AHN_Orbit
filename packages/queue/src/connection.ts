import { Redis } from 'ioredis';
import { serverEnv } from '@orbit/config';
import { logger } from '@orbit/observability';

/**
 * Redis connections for BullMQ.
 *
 * Two pools, deliberately separate:
 *
 *   • the **producer/shared** pool, used for enqueueing, locks and rate limit
 *     buckets. Ordinary command/response traffic.
 *   • one **blocking** connection per Worker. BullMQ's workers issue blocking
 *     reads (`BZPOPMIN`), which monopolise a connection — sharing one with the
 *     producer pool would stall every enqueue behind a poll.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ on blocking connections:
 * ioredis would otherwise abort a long block as a failed request.
 */

let shared: Redis | undefined;

function createConnection(role: string): Redis {
  const url = serverEnv().REDIS_URL;

  const connection = new Redis(url, {
    // Required by BullMQ. Without it, ioredis gives up on a blocking read and
    // the worker looks healthy while consuming nothing.
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    // Keep trying: a Redis restart should be a pause, not a dead worker.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    reconnectOnError: (error) => {
      // READONLY means we reached a replica after a failover. Reconnecting
      // picks up the new primary rather than failing every write.
      if (error.message.includes('READONLY')) return 2;
      return false;
    },
  });

  connection.on('error', (error: Error) => {
    // The URL can carry a password, so it is never logged — `redactUrl` exists
    // for the cases where a URL must be, and this is not one of them.
    logger.error('redis connection error', { role, error: error.message });
  });

  connection.on('reconnecting', () => {
    logger.warn('redis reconnecting', { role });
  });

  return connection;
}

/** The shared pool. Safe for queues, locks and buckets; never for a Worker. */
export function redis(): Redis {
  shared ??= createConnection('shared');
  return shared;
}

/**
 * A dedicated connection for one Worker.
 *
 * Each call returns a new connection on purpose — BullMQ blocks on it, so
 * reusing one across workers would serialise them.
 */
export function blockingConnection(role: string): Redis {
  return createConnection(role);
}

/** Close the shared pool. Workers close their own. */
export async function closeSharedConnection(): Promise<void> {
  if (!shared) return;
  const connection = shared;
  shared = undefined;
  await connection.quit().catch(() => connection.disconnect());
}

/**
 * True when this process is allowed to consume jobs.
 *
 * The web app produces; only the worker service consumes (docs/BUILD-PLAN.md
 * T1.11 DoD: "the web app **never** constructs a `Worker`"). A `Worker` inside
 * a Next.js server would be started per-instance and per-route-bundle, would
 * hold blocking connections a request lifecycle cannot manage, and would make
 * concurrency a function of autoscaling. `assertWorkerProcess` enforces it at
 * runtime rather than by convention — see `worker.ts`.
 */
export function isWorkerProcess(): boolean {
  return process.env.ORBIT_ROLE === 'worker';
}
