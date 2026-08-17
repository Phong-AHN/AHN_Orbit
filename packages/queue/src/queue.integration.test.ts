import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderValidationError,
  PublishingTimeoutError,
} from '@orbit/core';
import { redis, closeSharedConnection } from './connection.js';
import { cancelJob, closeQueues, enqueue, queueDepths, queueFor } from './producer.js';
import { acquireLock, LOCK_UNAVAILABLE, publishLockKey, releaseLock, withLock } from './lock.js';
import { applyProviderUsage, bucketState, rateLimitKey, takeToken } from './rate-limit.js';
import {
  deadLetterCount,
  discardDeadLetter,
  getDeadLetter,
  listDeadLetters,
  recordDeadLetter,
} from './dead-letter.js';
import { runAttempt, startWorker } from './worker.js';
import { shutdown } from './shutdown.js';

/**
 * The queue layer against **real Redis**.
 *
 * What a unit test cannot prove: that the deterministic job id actually
 * suppresses a duplicate enqueue, that the token bucket refills the way the Lua
 * says it does, that a lock is genuinely mutually exclusive, and that a worker
 * really drains in-flight work on shutdown rather than merely resolving.
 */

const ORG = '018fc100-0000-7000-8000-0000c1000001';
const VARIANT = '018fc100-0000-7000-8000-0000c1000002';
const JOB = '018fc100-0000-7000-8000-0000c1000003';

function publishPayload(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORG,
    correlationId: 'itest-corr',
    postVariantId: VARIANT,
    idempotencyKey: 'publish:v1:hash',
    publishingJobId: JOB,
    ...overrides,
  };
}

/** Everything this suite writes lives under keys we can sweep. */
async function flushTestKeys() {
  const connection = redis();
  const patterns = ['bull:*', 'dlq:*', 'lock:publish:*', 'ratelimit:*'];

  for (const pattern of patterns) {
    let cursor = '0';
    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await connection.del(...keys);
    } while (cursor !== '0');
  }
}

beforeAll(async () => {
  // The consumer half refuses to run without this, by design.
  process.env.ORBIT_ROLE = 'worker';
  await redis().ping();
});

beforeEach(async () => {
  await flushTestKeys();
});

afterAll(async () => {
  await flushTestKeys();
  await closeQueues();
  await closeSharedConnection();
});

// ── Enqueue and idempotency layer 1 ─────────────────────────────────────────

describe('enqueueing', () => {
  it('adds a job that can be read back', async () => {
    const jobId = await enqueue('publish', publishPayload(), { jobId: 'publish:v1:hash' });

    expect(jobId).toBe('publish:v1:hash');

    const job = await queueFor('publish').getJob('publish:v1:hash');
    expect(job?.data).toMatchObject({ postVariantId: VARIANT, organizationId: ORG });
  });

  it('silently drops a duplicate add with the same job id', async () => {
    // Idempotency layer 1. Two schedulers racing, or a retry of the enqueue
    // itself, must not produce two publishes.
    await enqueue('publish', publishPayload(), { jobId: 'publish:v1:hash' });
    await enqueue('publish', publishPayload(), { jobId: 'publish:v1:hash' });
    await enqueue('publish', publishPayload(), { jobId: 'publish:v1:hash' });

    const counts = await queueFor('publish').getJobCounts('waiting', 'delayed');
    expect((counts.waiting ?? 0) + (counts.delayed ?? 0)).toBe(1);
  });

  it('refuses an invalid payload at the producer, before it reaches a queue', async () => {
    await expect(
      enqueue('publish', { organizationId: 'nope', correlationId: 'x' } as never),
    ).rejects.toThrow();

    const counts = await queueFor('publish').getJobCounts('waiting');
    expect(counts.waiting ?? 0).toBe(0);
  });

  it('cancels a job that has not started', async () => {
    await enqueue('publish', publishPayload(), { jobId: 'cancel-me', delayMs: 60_000 });

    expect(await cancelJob('publish', 'cancel-me')).toBe(true);
    expect(await queueFor('publish').getJob('cancel-me')).toBeUndefined();
  });

  it('reports cancelling an unknown job as a no-op rather than throwing', async () => {
    // Cancellation is best effort by nature — the database, not the queue, is
    // the source of truth for whether a publish should proceed.
    expect(await cancelJob('publish', 'never-existed')).toBe(false);
  });
});

// ── Metrics ─────────────────────────────────────────────────────────────────

describe('queue depth and age', () => {
  it('reports depth and the age of the oldest waiting job', async () => {
    await enqueue('publish', publishPayload(), { jobId: 'depth-1' });
    await enqueue('publish', publishPayload({ correlationId: 'c2' }), { jobId: 'depth-2' });

    const depths = await queueDepths();
    const publish = depths.find((d) => d.queue === 'publish');

    expect(publish?.waiting).toBe(2);
    // Age is the signal that actually says whether work is moving.
    expect(publish?.oldestWaitingMs).toBeGreaterThanOrEqual(0);
  });

  it('covers every declared queue', async () => {
    const depths = await queueDepths();
    expect(depths.map((d) => d.queue).sort()).toEqual(
      [
        'account-health',
        'analytics',
        'maintenance',
        'media',
        'notifications',
        'publish',
        'reports',
        'scheduler',
      ].sort(),
    );
  });
});

// ── Locks (idempotency layer 3) ─────────────────────────────────────────────

describe('advisory locks', () => {
  it('grants a lock to one holder only', async () => {
    const key = publishLockKey(VARIANT);

    const first = await acquireLock(key, 5_000);
    const second = await acquireLock(key, 5_000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    if (first) await releaseLock(first);
  });

  it('releases so the next caller can take it', async () => {
    const key = publishLockKey(VARIANT);
    const lock = await acquireLock(key, 5_000);
    expect(lock).not.toBeNull();

    if (lock) expect(await releaseLock(lock)).toBe(true);

    const next = await acquireLock(key, 5_000);
    expect(next).not.toBeNull();
    if (next) await releaseLock(next);
  });

  it('does not let a stale holder release someone else lock', async () => {
    // The compare-and-delete that stops a slow worker whose lease expired from
    // deleting the lock a different worker has since taken.
    const key = publishLockKey(VARIANT);
    const stale = await acquireLock(key, 60);
    expect(stale).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 120));

    const fresh = await acquireLock(key, 5_000);
    expect(fresh).not.toBeNull();

    if (stale) expect(await releaseLock(stale)).toBe(false);
    // The new holder still owns it.
    expect(await redis().get(key)).toBe(fresh?.token);

    if (fresh) await releaseLock(fresh);
  });

  it('expires a lock so a crashed worker cannot hold it forever', async () => {
    const key = publishLockKey(VARIANT);
    await acquireLock(key, 60);

    await new Promise((resolve) => setTimeout(resolve, 120));

    const next = await acquireLock(key, 5_000);
    expect(next).not.toBeNull();
    if (next) await releaseLock(next);
  });

  it('runs work under a lock and releases it afterwards', async () => {
    const key = publishLockKey(VARIANT);

    const result = await withLock(key, 5_000, async () => 'done');

    expect(result).toBe('done');
    expect(await redis().get(key)).toBeNull();
  });

  it('reports the lock as unavailable rather than waiting', async () => {
    // A publish that cannot get its account's lock should requeue, not hold a
    // worker slot blocking.
    const key = publishLockKey(VARIANT);
    const held = await acquireLock(key, 5_000);

    const result = await withLock(key, 5_000, async () => 'should not run');
    expect(result).toBe(LOCK_UNAVAILABLE);

    if (held) await releaseLock(held);
  });

  it('releases the lock even when the work throws', async () => {
    const key = publishLockKey(VARIANT);

    await expect(withLock(key, 5_000, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );

    expect(await redis().get(key)).toBeNull();
  });
});

// ── Rate limiting ───────────────────────────────────────────────────────────

describe('provider rate limiting', () => {
  const config = { capacity: 5, refillWindowMs: 1_000 };

  it('allows up to capacity then refuses', async () => {
    const key = rateLimitKey('FACEBOOK', VARIANT);
    const now = Date.now();

    for (let i = 0; i < 5; i += 1) {
      expect((await takeToken(key, config, 1, now)).allowed).toBe(true);
    }

    const refused = await takeToken(key, config, 1, now);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it('tells the caller exactly how long to wait', async () => {
    const key = rateLimitKey('FACEBOOK', VARIANT);
    const now = Date.now();

    for (let i = 0; i < 5; i += 1) await takeToken(key, config, 1, now);

    const refused = await takeToken(key, config, 1, now);
    // 5 tokens per 1000ms ⇒ one token per 200ms.
    expect(refused.retryAfterMs).toBeLessThanOrEqual(200);
  });

  it('refills continuously rather than in fixed windows', async () => {
    // A fixed window lets a caller spend the budget at the boundary and again
    // immediately after — exactly the burst a provider counts against us.
    const key = rateLimitKey('FACEBOOK', VARIANT);
    const start = Date.now();

    for (let i = 0; i < 5; i += 1) await takeToken(key, config, 1, start);
    expect((await takeToken(key, config, 1, start)).allowed).toBe(false);

    // Half a window later, about half the capacity is back — not all of it.
    const halfway = await takeToken(key, config, 1, start + 500);
    expect(halfway.allowed).toBe(true);

    const state = await bucketState(key);
    expect(state?.tokens).toBeLessThan(config.capacity);
  });

  it('never exceeds capacity however long it idles', async () => {
    const key = rateLimitKey('FACEBOOK', VARIANT);
    const start = Date.now();

    await takeToken(key, config, 1, start);
    await takeToken(key, config, 1, start + 3_600_000);

    const state = await bucketState(key);
    expect(state?.tokens).toBeLessThanOrEqual(config.capacity);
  });

  it('narrows the bucket when the provider reports high usage', async () => {
    // Meta's figures move, so static constants would either throttle us
    // pointlessly or not at all.
    const key = rateLimitKey('FACEBOOK', VARIANT);
    const now = Date.now();

    await takeToken(key, config, 1, now);
    await applyProviderUsage(key, 0.9, config, now);

    const state = await bucketState(key);
    expect(state?.tokens).toBeLessThanOrEqual(1);
  });

  it('leaves the bucket alone when reported usage is low', async () => {
    const key = rateLimitKey('FACEBOOK', VARIANT);
    const now = Date.now();

    await takeToken(key, config, 1, now);
    const before = await bucketState(key);

    await applyProviderUsage(key, 0.2, config, now);

    expect((await bucketState(key))?.tokens).toBe(before?.tokens);
  });

  it('keeps buckets separate per account', async () => {
    const a = rateLimitKey('FACEBOOK', 'account-a');
    const b = rateLimitKey('FACEBOOK', 'account-b');
    const now = Date.now();

    for (let i = 0; i < 5; i += 1) await takeToken(a, config, 1, now);

    expect((await takeToken(a, config, 1, now)).allowed).toBe(false);
    // One noisy account must not throttle another.
    expect((await takeToken(b, config, 1, now)).allowed).toBe(true);
  });
});

// ── Dead letters ────────────────────────────────────────────────────────────

describe('the dead-letter set', () => {
  it('records an entry with the full cause chain', async () => {
    const root = new Error('connect ECONNREFUSED 10.0.1.5:5432');
    const error = new ProviderUnavailableError('publish failed', { cause: root });

    const entry = await recordDeadLetter({
      queue: 'publish',
      jobId: 'dead-1',
      organizationId: ORG,
      correlationId: 'corr-dead',
      error,
      reason: 'ATTEMPTS_EXHAUSTED',
      attempts: 4,
    });

    const stored = await getDeadLetter(entry.id);
    expect(stored).toMatchObject({
      queue: 'publish',
      jobId: 'dead-1',
      organizationId: ORG,
      errorCode: 'PROVIDER_UNAVAILABLE',
      reason: 'ATTEMPTS_EXHAUSTED',
      attempts: 4,
    });
    expect(stored?.chain).toHaveLength(2);
  });

  it('never stores an internal detail from an unknown cause', async () => {
    const entry = await recordDeadLetter({
      queue: 'publish',
      jobId: 'dead-2',
      organizationId: ORG,
      correlationId: 'corr',
      error: new Error('token=EAAG1234secret host=10.0.1.5'),
      reason: 'NOT_RETRYABLE',
      attempts: 1,
    });

    const stored = await getDeadLetter(entry.id);
    // This ends up in the admin panel; a Graph error body can carry a token.
    expect(JSON.stringify(stored)).not.toContain('EAAG1234secret');
    expect(JSON.stringify(stored)).not.toContain('10.0.1.5');
  });

  it('lists newest first and counts', async () => {
    for (const jobId of ['a', 'b', 'c']) {
      await recordDeadLetter({
        queue: 'publish',
        jobId,
        organizationId: ORG,
        correlationId: 'corr',
        error: new ProviderValidationError('nope'),
        reason: 'NOT_RETRYABLE',
        attempts: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(await deadLetterCount()).toBe(3);
    const entries = await listDeadLetters();
    expect(entries[0]?.jobId).toBe('c');
  });

  it('discards an entry once it has been dealt with', async () => {
    const entry = await recordDeadLetter({
      queue: 'publish',
      jobId: 'discard-me',
      organizationId: ORG,
      correlationId: 'corr',
      error: new ProviderValidationError('nope'),
      reason: 'NOT_RETRYABLE',
      attempts: 1,
    });

    await discardDeadLetter(entry.id);

    expect(await getDeadLetter(entry.id)).toBeNull();
    expect(await deadLetterCount()).toBe(0);
  });
});

// ── The attempt loop, end to end ────────────────────────────────────────────

describe('the retry loop against a real queue', () => {
  it('re-enqueues a retryable failure as a delayed job', async () => {
    const processor = vi.fn().mockRejectedValue(new ProviderUnavailableError('down'));

    const outcome = await runAttempt('publish', publishPayload(), 'retry-1', processor);

    expect(outcome).toBe('RETRYING');

    const counts = await queueFor('publish').getJobCounts('delayed');
    expect(counts.delayed).toBe(1);
  });

  it('dead-letters an ambiguous publish rather than requeueing it', async () => {
    const processor = vi.fn().mockRejectedValue(new PublishingTimeoutError());

    await expect(
      runAttempt('publish', publishPayload(), 'ambiguous-1', processor),
    ).rejects.toThrow();

    // Nothing queued — the whole point.
    const counts = await queueFor('publish').getJobCounts('waiting', 'delayed');
    expect((counts.waiting ?? 0) + (counts.delayed ?? 0)).toBe(0);

    const entries = await listDeadLetters();
    expect(entries[0]).toMatchObject({ reason: 'NEEDS_RECONCILIATION' });
  });

  it('reschedules a rate limit at the provider figure', async () => {
    const processor = vi
      .fn()
      .mockRejectedValue(new ProviderRateLimitError('slow', { retryAfterSeconds: 2 }));

    const outcome = await runAttempt('publish', publishPayload(), 'rl-1', processor);

    expect(outcome).toBe('RESCHEDULED');
    expect((await queueFor('publish').getJobCounts('delayed')).delayed).toBe(1);
    expect(await deadLetterCount()).toBe(0);
  });
});

// ── The worker itself ───────────────────────────────────────────────────────

describe('a running worker', () => {
  it('consumes a job and reports success', async () => {
    const seen: string[] = [];

    const worker = startWorker(
      'publish',
      async ({ payload }) => {
        seen.push(payload.postVariantId);
      },
      { concurrency: 1 },
    );

    try {
      await enqueue('publish', publishPayload(), { jobId: 'consume-1' });

      await vi.waitFor(
        () => {
          expect(seen).toContain(VARIANT);
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      await worker.close();
    }
  });

  it('drains an in-flight job before shutting down', async () => {
    // The behaviour that matters most: a publish cut off mid-call is the
    // ambiguous outcome the idempotency design exists to avoid.
    let started = false;
    let finished = false;

    const worker = startWorker(
      'publish',
      async () => {
        started = true;
        await new Promise((resolve) => setTimeout(resolve, 400));
        finished = true;
      },
      { concurrency: 1 },
    );

    await enqueue('publish', publishPayload(), { jobId: 'drain-1' });

    await vi.waitFor(
      () => {
        expect(started).toBe(true);
      },
      { timeout: 10_000, interval: 25 },
    );

    // Shut down while it is deliberately mid-flight.
    await shutdown({ workers: [worker], graceMs: 10_000 });

    expect(finished).toBe(true);
  });
});
