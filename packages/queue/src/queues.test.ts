import { describe, expect, it } from 'vitest';
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
    const platformWide = new Set(['maintenance', 'scheduler']);

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
