import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { newCorrelationId } from '@orbit/core';
import { logger, logError, recordJobOutcome, withLogContext } from '@orbit/observability';
import { blockingConnection, isWorkerProcess } from './connection.js';
import { QUEUE_DEFINITIONS, parsePayload, type PayloadOf, type QueueName } from './queues.js';
import { decideRetry, describeFailure, errorCodeOf, MAX_ATTEMPTS } from './retry.js';
import { recordDeadLetter } from './dead-letter.js';
import { enqueue } from './producer.js';

/**
 * The consumer half of the queue layer.
 *
 * Everything here is refused outside the worker process, so a `Worker` cannot
 * be started inside a Next.js server — see `assertWorkerProcess`.
 *
 * ## Retry lives here, not in BullMQ
 *
 * Jobs are added with `attempts: 1`, and a failed attempt is re-enqueued by
 * `runAttempt` after `decideRetry` has consulted the error taxonomy. The reason
 * is that BullMQ's `attempts` count cannot express our three outcomes: a rate
 * limit that reschedules *without* consuming an attempt, and a timeout that
 * must not be retried at all until something has reconciled it. Encoding that
 * as a number would silently turn an ambiguous publish into a duplicate one.
 *
 * The attempt number therefore travels in the payload's re-enqueue, not in
 * BullMQ's own bookkeeping.
 */

export interface JobContext<Q extends QueueName> {
  payload: PayloadOf<Q>;
  /** 1-based; survives re-enqueues. */
  attempt: number;
  jobId: string;
  correlationId: string;
}

export type Processor<Q extends QueueName> = (context: JobContext<Q>) => Promise<void>;

export interface WorkerOptions {
  /** Overrides the catalogue default. Used to pin concurrency per deployment. */
  concurrency?: number;
  maxAttempts?: number;
}

/**
 * Refuse to consume jobs outside the worker service.
 *
 * The web app produces; the worker consumes (docs/BUILD-PLAN.md T1.11 DoD).
 * A `Worker` inside a web server would hold blocking Redis connections across
 * request lifecycles it does not control, start one consumer per server
 * instance, and make queue concurrency a side effect of HTTP autoscaling.
 * A lint rule would catch the import; this catches the deployment mistake of
 * running the worker bundle with the wrong role.
 */
export function assertWorkerProcess(): void {
  if (isWorkerProcess()) return;

  throw new Error(
    'Refusing to start a queue Worker: ORBIT_ROLE is not "worker". ' +
      'Job processing belongs to apps/worker; apps/web may only enqueue.',
  );
}

/** Where the attempt number is carried across a re-enqueue. */
const ATTEMPT_FIELD = '__attempt';

function attemptOf(raw: unknown): number {
  if (raw && typeof raw === 'object' && ATTEMPT_FIELD in raw) {
    const value = (raw as Record<string, unknown>)[ATTEMPT_FIELD];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return value;
  }
  return 1;
}

/**
 * Run one attempt, and decide what happens next.
 *
 * Exported separately from `startWorker` so the whole retry/dead-letter path is
 * testable without Redis or a running worker.
 */
export async function runAttempt<Q extends QueueName>(
  queue: Q,
  raw: unknown,
  jobId: string,
  processor: Processor<Q>,
  options: {
    maxAttempts?: number;
    /** Injected so tests can observe re-enqueues without a live queue. */
    reenqueue?: (payload: unknown, delayMs: number) => Promise<void>;
    deadLetter?: typeof recordDeadLetter;
  } = {},
): Promise<'SUCCEEDED' | 'RETRYING' | 'RESCHEDULED' | 'DEAD_LETTERED'> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const attempt = attemptOf(raw);

  // A payload that does not parse can never succeed, so it is dead-lettered
  // immediately rather than retried four times on a schedule.
  let payload: PayloadOf<Q>;
  try {
    payload = parsePayload(queue, raw);
  } catch (error) {
    await (options.deadLetter ?? recordDeadLetter)({
      queue,
      jobId,
      organizationId: null,
      correlationId: newCorrelationId(),
      error,
      reason: 'NOT_RETRYABLE',
      attempts: attempt,
    });
    // Tells BullMQ not to retry on its own either.
    throw new UnrecoverableError(`Invalid payload for queue ${queue}`);
  }

  const correlationId = payload.correlationId;
  const organizationId =
    'organizationId' in payload && typeof payload.organizationId === 'string'
      ? payload.organizationId
      : null;

  return withLogContext({ correlationId, queue, jobId, attempt }, async () => {
    const startedAt = Date.now();

    try {
      await processor({ payload, attempt, jobId, correlationId });

      logger.info('job succeeded', { durationMs: Date.now() - startedAt });
      recordJobOutcome(queue, 'SUCCEEDED');
      return 'SUCCEEDED';
    } catch (error) {
      const decision = decideRetry(error, attempt, maxAttempts);
      const failure = describeFailure(error);

      // The full error goes to the log (which redacts); only the safe summary
      // travels onward into the job record and the dead-letter set.
      logError('job attempt failed', error, {
        durationMs: Date.now() - startedAt,
        errorCode: errorCodeOf(error),
        decision: decision.action,
      });

      if (decision.action === 'FAIL') {
        await (options.deadLetter ?? recordDeadLetter)({
          queue,
          jobId,
          organizationId,
          correlationId,
          error,
          reason: decision.reason,
          attempts: attempt,
          // Carried so an operator can re-enqueue it (T1.18). Identifiers only,
          // by the payload rules in docs/ARCHITECTURE.md §5.1.
          payload,
        });

        recordJobOutcome(queue, 'DEAD_LETTERED');
        throw new UnrecoverableError(`${failure.code}: ${failure.message}`);
      }

      // A rate limit does not consume an attempt; a genuine failure does.
      const nextAttempt = decision.consumesAttempt ? attempt + 1 : attempt;
      const nextPayload = { ...payload, [ATTEMPT_FIELD]: nextAttempt };

      const reenqueue =
        options.reenqueue ??
        (async (value: unknown, delayMs: number) => {
          await enqueue(queue, value as PayloadOf<Q>, {
            delayMs,
            // A retry has already waited; let it overtake fresh work.
            priority: 1,
          });
        });

      await reenqueue(nextPayload, decision.delayMs);

      logger.warn('job re-enqueued', {
        action: decision.action,
        delayMs: decision.delayMs,
        nextAttempt,
        errorCode: failure.code,
      });

      const outcome = decision.action === 'RESCHEDULE' ? 'RESCHEDULED' : 'RETRYING';
      recordJobOutcome(queue, outcome);
      return outcome;
    }
  });
}

export interface RunningWorker {
  name: QueueName;
  close: () => Promise<void>;
}

/**
 * Start consuming one queue.
 *
 * The returned handle's `close()` waits for in-flight jobs to finish — see
 * `shutdown.ts`, which is what actually wires it to a signal.
 */
export function startWorker<Q extends QueueName>(
  name: Q,
  processor: Processor<Q>,
  options: WorkerOptions = {},
): RunningWorker {
  assertWorkerProcess();

  const concurrency = options.concurrency ?? QUEUE_DEFINITIONS[name].concurrency;

  const worker = new Worker(
    name,
    async (job: Job) => {
      await runAttempt(name, job.data, job.id ?? 'unknown', processor, {
        ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      });
    },
    {
      connection: blockingConnection(`worker:${name}`),
      concurrency,
      // If a worker dies mid-job, this is how long before another may take it.
      // Long enough to cover a slow provider call, short enough that a crashed
      // worker's job is not stranded for an operator to notice.
      lockDuration: 120_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    },
  );

  worker.on('error', (error: Error) => {
    logger.error('worker error', { queue: name, error: error.message });
  });

  worker.on('stalled', (jobId: string) => {
    // Worth an alarm: it means a worker died holding this job, or a job ran
    // past `lockDuration`. Either way it is about to be retried by someone else.
    logger.warn('job stalled and will be reclaimed', { queue: name, jobId, securityEvent: false });
  });

  logger.info('worker started', { queue: name, concurrency });

  return {
    name,
    close: async () => {
      // `false` = do not force. In-flight jobs run to completion.
      await worker.close(false);
      logger.info('worker stopped', { queue: name });
    },
  };
}
