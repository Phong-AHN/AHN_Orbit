import { logger } from '@orbit/observability';
import { redis } from './connection.js';
import { describeFailure, type RetryRefusal } from './retry.js';
import type { QueueName } from './queues.js';

/**
 * The dead-letter set (SRS §13, §28).
 *
 * A job that will not be retried lands here rather than vanishing into BullMQ's
 * failed set, because the two questions an operator asks — "what is stuck?" and
 * "why?" — need the *whole* error chain, and the chain has to be safe to render
 * in the admin panel.
 *
 * A Redis sorted set keyed by time so the newest is cheap to read, plus a hash
 * per entry. It is a queryable record, not a queue: nothing consumes it. A
 * manual retry re-enqueues the original job explicitly (SRS §13).
 *
 * Entries expire after 30 days. Anything needing a permanent record is already
 * in `PublishingAttempt`, which is in Postgres and belongs to a tenant; this is
 * an operational aid.
 */

const DEAD_LETTER_INDEX = 'dlq:index';
const RETENTION_MS = 30 * 24 * 3_600 * 1_000;

export interface DeadLetterEntry {
  id: string;
  queue: QueueName;
  jobId: string;
  organizationId: string | null;
  correlationId: string;
  errorCode: string;
  /** Safe message only — never a provider payload or a token (SRS §33). */
  message: string;
  reason: RetryRefusal;
  attempts: number;
  failedAt: number;
  /** The chain of causes, each already reduced to a safe code and message. */
  chain: Array<{ code: string; message: string }>;
  /**
   * The job's payload, so an operator can re-enqueue it (T1.18).
   *
   * Safe to store because of what a payload already is: **identifiers only** —
   * no post bodies, no credentials, no signed URLs (SRS §4.9). It is the same
   * object BullMQ already holds in Redis; keeping a copy here just means a dead
   * letter can be acted on rather than only read.
   *
   * Absent when the payload never parsed, which is precisely the case that
   * cannot be retried — there is nothing valid to re-enqueue.
   */
  payload?: unknown;
}

function entryKey(id: string): string {
  return `dlq:entry:${id}`;
}

/**
 * Walk the `cause` chain into safe, structured frames.
 *
 * The chain is what makes a dead letter diagnosable — "publish failed" is
 * useless, "publish failed ← provider unavailable ← socket hang up" is not.
 * Each frame goes through `describeFailure`, so a provider error body cannot
 * ride along into storage.
 */
export function causeChain(error: unknown, limit = 5): Array<{ code: string; message: string }> {
  const chain: Array<{ code: string; message: string }> = [];
  let current: unknown = error;

  while (current !== undefined && current !== null && chain.length < limit) {
    chain.push(describeFailure(current));
    current = current instanceof Error ? current.cause : undefined;
  }

  return chain;
}

export async function recordDeadLetter(input: {
  queue: QueueName;
  jobId: string;
  organizationId: string | null;
  correlationId: string;
  error: unknown;
  reason: RetryRefusal;
  attempts: number;
  /** Omitted when the payload never parsed — such an entry cannot be retried. */
  payload?: unknown;
}): Promise<DeadLetterEntry> {
  const failure = describeFailure(input.error);
  const now = Date.now();

  const entry: DeadLetterEntry = {
    id: `${input.queue}:${input.jobId}:${now}`,
    queue: input.queue,
    jobId: input.jobId,
    organizationId: input.organizationId,
    correlationId: input.correlationId,
    errorCode: failure.code,
    message: failure.message,
    reason: input.reason,
    attempts: input.attempts,
    failedAt: now,
    chain: causeChain(input.error),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  };

  const connection = redis();
  await connection
    .multi()
    .set(entryKey(entry.id), JSON.stringify(entry), 'PX', RETENTION_MS)
    .zadd(DEAD_LETTER_INDEX, now, entry.id)
    // Trim anything past the retention window so the index cannot grow forever.
    .zremrangebyscore(DEAD_LETTER_INDEX, 0, now - RETENTION_MS)
    .exec();

  logger.error('job dead-lettered', {
    queue: entry.queue,
    jobId: entry.jobId,
    organizationId: entry.organizationId,
    correlationId: entry.correlationId,
    errorCode: entry.errorCode,
    reason: entry.reason,
    attempts: entry.attempts,
  });

  return entry;
}

/** Newest first. Backs the admin panel's dead-letter view (SRS §28). */
export async function listDeadLetters(limit = 50): Promise<DeadLetterEntry[]> {
  const connection = redis();
  const ids = await connection.zrevrange(DEAD_LETTER_INDEX, 0, Math.max(limit - 1, 0));
  if (ids.length === 0) return [];

  const raw = await connection.mget(ids.map(entryKey));

  return raw
    .filter((value): value is string => value !== null)
    .map((value) => JSON.parse(value) as DeadLetterEntry);
}

export async function getDeadLetter(id: string): Promise<DeadLetterEntry | null> {
  const raw = await redis().get(entryKey(id));
  return raw ? (JSON.parse(raw) as DeadLetterEntry) : null;
}

/** Drop an entry once it has been dealt with. */
export async function discardDeadLetter(id: string): Promise<void> {
  await redis().multi().del(entryKey(id)).zrem(DEAD_LETTER_INDEX, id).exec();
}

export async function deadLetterCount(): Promise<number> {
  return redis().zcard(DEAD_LETTER_INDEX);
}
