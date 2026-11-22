import { beforeEach, describe, expect, it, vi } from 'vitest';
import { publishIdempotencyKey } from '@orbit/core';

/**
 * The stuck-publish sweep (D-128).
 *
 * It used to log variants stuck in `PUBLISHING` and stop there, and eleven
 * sat for up to two days. It now gives each a publish job, so the engine takes
 * the aged-out claim over and reconciles with the platform first.
 *
 * It also finds `SCHEDULED` variants whose queue job is gone — the post said
 * "Scheduled" for ever — and queues them again, or, hours late, fails them
 * with a reason. It never publishes anything itself.
 */

// Never the real database: `.env` points at production.
const variantFindMany = vi.fn();
const jobFindFirst = vi.fn();
const jobFindMany = vi.fn();
const enqueue = vi.fn();
const giveUpPublish = vi.fn();

vi.mock('@orbit/db', () => ({
  platformDb: {
    postVariant: { findMany: variantFindMany },
    publishingJob: { findFirst: jobFindFirst, findMany: jobFindMany },
  },
}));
vi.mock('@orbit/queue', () => ({ enqueue }));
vi.mock('../publishing/engine.js', () => ({ giveUpPublish }));

const { reconcileStuckJobs } = await import('./maintenance.js');

const claimedAt = new Date('2026-11-20T09:00:00.000Z');

beforeEach(() => {
  for (const mock of [variantFindMany, jobFindFirst, jobFindMany, enqueue, giveUpPublish]) {
    mock.mockReset();
  }
  variantFindMany.mockResolvedValue([]);
  jobFindMany.mockResolvedValue([]);
});

describe('variants stuck in PUBLISHING', () => {
  it('queues every one for the engine to reconcile, once per claim', async () => {
    variantFindMany.mockResolvedValue([
      { id: 'v-1', organizationId: 'org-1', socialAccountId: 'a-1', claimedAt, claimToken: 't' },
    ]);
    jobFindFirst.mockResolvedValue({ id: 'job-1', idempotencyKey: 'key-1' });

    await reconcileStuckJobs('corr-1');

    expect(enqueue).toHaveBeenCalledWith(
      'publish',
      {
        organizationId: 'org-1',
        correlationId: 'corr-1',
        postVariantId: 'v-1',
        idempotencyKey: 'key-1',
        publishingJobId: 'job-1',
      },
      // The same claim gives the same id, so sweeps do not stack jobs.
      { jobId: `recover-v-1-${claimedAt.getTime()}` },
    );
    // Its own tenant's job, never another's.
    expect(jobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { postVariantId: 'v-1', organizationId: 'org-1' } }),
    );
  });

  it('only looks at claims old enough to have been abandoned', async () => {
    await reconcileStuckJobs('corr-1');

    const where = variantFindMany.mock.calls[0]?.[0]?.where as {
      status: string;
      claimedAt: { lt: Date };
    };
    expect(where.status).toBe('PUBLISHING');
    expect(Date.now() - where.claimedAt.lt.getTime()).toBeGreaterThanOrEqual(15 * 60_000 - 1_000);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('carries on past a variant with no publishing job', async () => {
    variantFindMany.mockResolvedValue([
      { id: 'v-1', organizationId: 'org-1', socialAccountId: 'a-1', claimedAt, claimToken: 't' },
      { id: 'v-2', organizationId: 'org-1', socialAccountId: 'a-2', claimedAt, claimToken: 't' },
    ]);
    jobFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'job-2', idempotencyKey: 'key-2' });

    await reconcileStuckJobs('corr-1');

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[1]).toMatchObject({ postVariantId: 'v-2' });
  });
});

describe('scheduled variants whose queue job is gone', () => {
  const updatedAt = new Date(Date.now() - 30 * 60_000);

  function stalledJob(scheduledFor: Date, idempotencyKey?: string) {
    const contentHash = 'hash-1';
    return {
      id: 'job-9',
      organizationId: 'org-1',
      postVariantId: 'v-9',
      idempotencyKey:
        idempotencyKey ??
        publishIdempotencyKey({ postVariantId: 'v-9', scheduledFor, contentHash }),
      updatedAt,
      postVariant: { scheduledFor, contentHash },
    };
  }

  it('asks only for jobs past their next run, on variants still scheduled', async () => {
    await reconcileStuckJobs('corr-1');

    const where = jobFindMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
    expect(where['state']).toEqual({ in: ['PENDING', 'QUEUED', 'RUNNING'] });
    expect(where['OR']).toHaveLength(2);
    expect(where['postVariant']).toMatchObject({ status: 'SCHEDULED', deletedAt: null });
  });

  it('queues one that is still on time again, once', async () => {
    const scheduledFor = new Date(Date.now() - 40 * 60_000);
    jobFindMany.mockResolvedValue([stalledJob(scheduledFor)]);

    await reconcileStuckJobs('corr-1');

    expect(giveUpPublish).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'publish',
      expect.objectContaining({ postVariantId: 'v-9', publishingJobId: 'job-9' }),
      { jobId: `revive-job-9-${updatedAt.getTime()}` },
    );
  });

  it('fails one hours late with a reason instead of publishing it late', async () => {
    const scheduledFor = new Date(Date.now() - 3 * 60 * 60_000);
    jobFindMany.mockResolvedValue([stalledJob(scheduledFor)]);
    giveUpPublish.mockResolvedValue(true);

    await reconcileStuckJobs('corr-1');

    expect(enqueue).not.toHaveBeenCalled();
    expect(giveUpPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        postVariantId: 'v-9',
        publishingJobId: 'job-9',
        organizationId: 'org-1',
        code: 'PUBLISH_STALLED',
      }),
    );
  });

  it('never revives the job of a schedule the variant has since moved off', async () => {
    const scheduledFor = new Date(Date.now() - 40 * 60_000);
    jobFindMany.mockResolvedValue([stalledJob(scheduledFor, 'key-of-an-older-schedule')]);

    await reconcileStuckJobs('corr-1');

    expect(enqueue).not.toHaveBeenCalled();
    expect(giveUpPublish).not.toHaveBeenCalled();
  });
});
