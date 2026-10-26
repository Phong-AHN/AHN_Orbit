import { describe, expect, it } from 'vitest';
import { DEFAULT_JOB_OPTIONS } from './producer.js';
import {
  QUEUE_DEFINITIONS,
  QUEUE_NAMES,
  isQueueName,
  isTenantScopedQueue,
  parsePayload,
} from './queues.js';

const ORG = '018f0000-0000-7000-8000-000000000001';
const VARIANT = '018f0000-0000-7000-8000-000000000002';
const JOB = '018f0000-0000-7000-8000-000000000003';

describe('the queue catalogue', () => {
  it('matches the queues ARCHITECTURE.md §5.1 declares', () => {
    expect(QUEUE_NAMES.sort()).toEqual(
      [
        'account-health',
        'analytics',
        // Its own queue rather than a second shape on `analytics`: it spends a
        // different provider quota, and a comment backlog on a viral post must
        // not starve the metrics the analytics screen depends on.
        'engagement',
        'maintenance',
        'media',
        'notifications',
        'publish',
        // Produced by a person rather than a schedule (T3.5). Rendering reads
        // a lot of rows, and nobody is blocked on the second report.
        'reports',
        // The 30s sweep (T1.12). Its own queue rather than sharing
        // `maintenance`, which runs at concurrency 1 — a slow retention pass
        // would delay the sweep, and a late sweep means posts publish late.
        'scheduler',
        // D-107. Stored webhook events, platform-wide until each matching
        // account is resolved; and the per-account conversation backfill.
        'webhooks',
        'messaging',
        // D-108. The AI assistant considering one conversation.
        'assistant',
      ].sort(),
    );
  });

  it('gives every queue a positive concurrency', () => {
    for (const name of QUEUE_NAMES) {
      expect(QUEUE_DEFINITIONS[name].concurrency).toBeGreaterThan(0);
    }
  });

  it('recognises only real queue names', () => {
    expect(isQueueName('publish')).toBe(true);
    expect(isQueueName('publish-now')).toBe(false);
    expect(isQueueName('__proto__')).toBe(false);
  });

  it('treats every queue but the platform-wide sweeps as tenant-scoped', () => {
    // `maintenance` and `scheduler` sweep the whole platform and carry no
    // tenant to assert. Everything they enqueue is tenant-scoped normally.
    const platformWide = new Set(['maintenance', 'scheduler', 'webhooks']);

    for (const name of QUEUE_NAMES) {
      expect(isTenantScopedQueue(name)).toBe(!platformWide.has(name));
    }
  });
});

describe('payload validation', () => {
  it('accepts a well-formed publish payload', () => {
    const payload = {
      organizationId: ORG,
      correlationId: 'abc-123',
      postVariantId: VARIANT,
      idempotencyKey: 'publish:v1:hash',
      publishingJobId: JOB,
    };

    expect(parsePayload('publish', payload)).toEqual(payload);
  });

  it('rejects a payload missing its tenant assertion', () => {
    expect(() =>
      parsePayload('publish', {
        correlationId: 'abc',
        postVariantId: VARIANT,
        idempotencyKey: 'k',
        publishingJobId: JOB,
      }),
    ).toThrow();
  });

  it('rejects a non-uuid where an id is required', () => {
    // A hand-crafted job must not reach provider code.
    expect(() =>
      parsePayload('publish', {
        organizationId: 'not-a-uuid',
        correlationId: 'abc',
        postVariantId: VARIANT,
        idempotencyKey: 'k',
        publishingJobId: JOB,
      }),
    ).toThrow();
  });

  it('rejects a correlation id long enough to bloat every log line', () => {
    expect(() =>
      parsePayload('media', {
        organizationId: ORG,
        correlationId: 'x'.repeat(500),
        mediaAssetId: VARIANT,
      }),
    ).toThrow();
  });

  it('rejects a payload aimed at the wrong queue', () => {
    expect(() =>
      parsePayload('media', {
        organizationId: ORG,
        correlationId: 'abc',
        postVariantId: VARIANT,
        idempotencyKey: 'k',
        publishingJobId: JOB,
      }),
    ).toThrow();
  });

  it('accepts maintenance without a tenant, and only known tasks', () => {
    expect(parsePayload('maintenance', { correlationId: 'cron', task: 'retention' })).toEqual({
      correlationId: 'cron',
      task: 'retention',
    });

    expect(() =>
      parsePayload('maintenance', { correlationId: 'cron', task: 'drop-tables' }),
    ).toThrow();
  });

  it('keeps post content out of the payload', () => {
    // Bodies do not belong in Redis, and a job queued before an edit must not
    // be able to publish the stale copy.
    const publishFields = Object.keys(QUEUE_DEFINITIONS.publish.schema.shape);
    expect(publishFields).not.toContain('body');
    expect(publishFields).not.toContain('content');
    expect(publishFields).not.toContain('accessToken');
  });
});

/**
 * Redis runs `noeviction`, so a full instance refuses every write.
 *
 * That is the right policy for a queue — a job must never be evicted to make
 * room — and it means unbounded retention is not a disk-space problem but an
 * availability one. `removeOnFail` was `false`, keeping every failed job
 * forever, and production answered 500 on unrelated endpoints with
 * `OOM command not allowed` raised inside a BullMQ Lua script.
 *
 * The justification in the code was that the admin dead-letter view needed the
 * trail. It does not: that view reads `dlq:index`, which carries its own
 * 30-day TTL and trims its index on every write.
 */
describe('job retention is bounded', () => {
  it('bounds failed jobs by both count and age', () => {
    const onFail = DEFAULT_JOB_OPTIONS.removeOnFail;

    // `false` means "keep forever" and is what caused the outage.
    expect(onFail).not.toBe(false);
    expect(typeof onFail).toBe('object');
    expect(onFail).toMatchObject({ count: expect.any(Number), age: expect.any(Number) });
  });

  it('bounds completed jobs by both count and age', () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toMatchObject({
      count: expect.any(Number),
      age: expect.any(Number),
    });
  });

  /**
   * The failure window matches the dead-letter store's retention, so the
   * `failed` count and the admin view agree on what "recent" means.
   */
  it('keeps failures for the same window the dead-letter store does', () => {
    const onFail = DEFAULT_JOB_OPTIONS.removeOnFail as { age: number };
    expect(onFail.age).toBe(30 * 24 * 3_600);
  });

  /** The worker owns retry policy; BullMQ must not re-run a job behind it. */
  it('leaves retries to the worker', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(1);
  });
});
