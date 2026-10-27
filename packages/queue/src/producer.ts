import { Queue, type JobsOptions } from 'bullmq';
import { logger } from '@orbit/observability';
import { redis } from './connection.js';
import { parsePayload, QUEUE_NAMES, type PayloadOf, type QueueName } from './queues.js';

/**
 * Enqueueing (docs/ARCHITECTURE.md §5.1).
 *
 * This is the half of the queue layer `apps/web` is allowed to touch. It holds
 * no blocking connections and starts no processors, so importing it from a
 * request handler is safe.
 *
 * Retries are **not** delegated to BullMQ's `attempts`/`backoff`. The decision
 * of whether an error is worth retrying belongs to the error taxonomy, and the
 * decision of whether a *publish* may be retried belongs to the reconciliation
 * logic — neither is expressible as a fixed attempt count. Jobs are therefore
 * added with `attempts: 1` and re-enqueued deliberately by the worker after
 * `decideRetry` has ruled. `MAX_ATTEMPTS` still bounds that loop.
 */

/**
 * Job retention, exported so it can be asserted without a Redis connection.
 *
 * Both bounds matter and for different reasons. `removeOnComplete` keeps a
 * short debugging trail. `removeOnFail` is bounded because Redis runs
 * `noeviction` — correct for a queue, since a job must never be evicted to
 * make room — which means a full Redis refuses every write and the product
 * answers 500 rather than merely queuing slowly.
 */
export const DEFAULT_JOB_OPTIONS = {
  // The worker owns retry policy; BullMQ must not second-guess it.
  attempts: 1,
  // A short success trail for debugging. Short because it is per queue, and
  // the 30-second sweeps alone complete thousands of jobs a day (2026-10-27).
  removeOnComplete: { count: 100, age: 3_600 },
  /**
   * Bounded, and it was not.
   *
   * This was `false` — keep every failed job forever — justified as the
   * trail behind the admin panel's dead-letter view (SRS §28). **That
   * view does not read these.** It reads `dlq:index`, the sorted set
   * `recordDeadLetter` writes, whose entries carry a 30-day TTL and
   * whose index is trimmed on every write. That store was already
   * bounded; this one was retaining payloads for no reader at all,
   * beyond the `failed` number in `getJobCounts`.
   *
   * Why it mattered more than wasted space: Redis runs `noeviction`,
   * which is correct for a queue — a job must never be evicted to make
   * room. So a full Redis does not degrade, it **refuses every write**,
   * and the first symptom is the whole product answering 500 with
   * `OOM command not allowed` raised from inside a BullMQ Lua script,
   * on endpoints that look nothing to do with queues.
   *
   * The window matches the dead-letter retention so the count and the
   * view agree about what "recent failures" means; the count cap bounds
   * a burst that arrives faster than the window expires.
   */
  removeOnFail: { count: 500, age: 30 * 24 * 3_600 },
} as const;

/**
 * How many events each queue's event stream keeps.
 *
 * BullMQ writes an entry to `bull:<queue>:events` for every state change and
 * keeps **10,000 per queue** unless told otherwise. Nothing in Orbit reads that
 * stream — no `QueueEvents` listener exists — and across thirteen queues it
 * was most of a small Redis. A full Redis under `noeviction` refuses every
 * write: the second `OOM command not allowed` outage (2026-10-27) came from
 * here and from the completed-job trail above, after the first one had
 * bounded failed jobs.
 *
 * Written into each queue's meta hash when the queue is opened, which is where
 * the worker's scripts read it too, so this one setting trims every writer.
 */
export const EVENTS_MAX_LEN = 200;

const queues = new Map<QueueName, Queue>();

export function queueFor<Q extends QueueName>(name: Q): Queue<PayloadOf<Q>> {
  let queue = queues.get(name);

  if (!queue) {
    queue = new Queue(name, {
      connection: redis(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
      streams: { events: { maxLen: EVENTS_MAX_LEN } },
    });
    queues.set(name, queue);
  }

  return queue as Queue<PayloadOf<Q>>;
}

export interface EnqueueOptions {
  /**
   * Stable job id. BullMQ silently drops a duplicate add with the same id,
   * which is idempotency layer 1 — the reason a publish passes its
   * `idempotencyKey` here rather than letting BullMQ generate one.
   */
  jobId?: string;
  delayMs?: number;
  /** Higher runs first. Used to let a retry overtake fresh work. */
  priority?: number;
}

/**
 * Add a job.
 *
 * The payload is parsed before it is added, so a producer bug fails at the call
 * site with a useful error rather than becoming a poison job that fails in a
 * worker minutes later.
 */
export async function enqueue<Q extends QueueName>(
  name: Q,
  payload: PayloadOf<Q>,
  options: EnqueueOptions = {},
): Promise<string | undefined> {
  const parsed = parsePayload(name, payload);

  const jobOptions: JobsOptions = {
    ...(options.jobId ? { jobId: options.jobId } : {}),
    ...(options.delayMs !== undefined ? { delay: options.delayMs } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
  };

  // BullMQ resolves the job-name type through a conditional on the payload
  // generic, which TypeScript cannot evaluate while `Q` is still open. The
  // payload itself is already checked by `parsePayload` above, so this widens
  // only the name — the part that carries no safety.
  const queue = queueFor(name) as unknown as Queue<Record<string, unknown>, unknown, string>;
  const job = await queue.add(name, parsed as Record<string, unknown>, jobOptions);

  logger.info('job enqueued', {
    queue: name,
    jobId: job.id,
    correlationId: parsed.correlationId,
    ...(options.delayMs ? { delayMs: options.delayMs } : {}),
  });

  return job.id;
}

/**
 * Remove a job that has not started.
 *
 * Returns false when it is already running or gone — cancellation is best
 * effort by nature, which is why the database, not the queue, is the source of
 * truth for whether a publish should proceed. A job that slips through still
 * finds its `PostVariant` no longer `SCHEDULED` and exits.
 */
export async function cancelJob(name: QueueName, jobId: string): Promise<boolean> {
  const job = await queueFor(name).getJob(jobId);
  if (!job) return false;

  const state = await job.getState();
  if (state === 'active' || state === 'completed') return false;

  await job.remove();
  logger.info('job cancelled', { queue: name, jobId, previousState: state });
  return true;
}

export interface QueueDepth {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  /** Age of the oldest waiting job, in ms. The number that signals a backlog. */
  oldestWaitingMs: number;
}

/**
 * Depth and age per queue (T1.11 DoD).
 *
 * Depth alone is a poor alarm: a queue of 500 fast jobs is healthy and a queue
 * of 3 stuck ones is not. Age of the oldest waiting job is what actually says
 * whether work is moving.
 */
export async function queueDepths(): Promise<QueueDepth[]> {
  return Promise.all(
    QUEUE_NAMES.map(async (name) => {
      const queue = queueFor(name);
      const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');

      const [oldest] = await queue.getWaiting(0, 0);
      const oldestWaitingMs = oldest?.timestamp ? Date.now() - oldest.timestamp : 0;

      return {
        queue: name,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        oldestWaitingMs,
      };
    }),
  );
}

/** Close every queue this process opened. */
export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  queues.clear();
}
