import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The stuck-publish sweep (2026-11-22).
 *
 * It used to log the variants and stop there, and eleven sat in `PUBLISHING`
 * for up to two days. It now gives each a publish job, so the engine takes the
 * aged-out claim over and reconciles with the platform first. It decides
 * nothing itself.
 */

const findMany = vi.fn();
const findFirst = vi.fn();
const enqueue = vi.fn();

vi.mock('@orbit/db', () => ({
  platformDb: {
    postVariant: { findMany },
    publishingJob: { findFirst },
  },
}));

vi.mock('@orbit/queue', () => ({ enqueue }));

const { reconcileStuckJobs } = await import('./maintenance.js');

const claimedAt = new Date('2026-11-20T09:00:00.000Z');

beforeEach(() => {
  findMany.mockReset();
  findFirst.mockReset();
  enqueue.mockReset();
});

describe('reconcileStuckJobs', () => {
  it('queues every stuck variant for the engine to reconcile, once per claim', async () => {
    findMany.mockResolvedValue([
      { id: 'v-1', organizationId: 'org-1', socialAccountId: 'a-1', claimedAt, claimToken: 't' },
    ]);
    findFirst.mockResolvedValue({ id: 'job-1', idempotencyKey: 'key-1' });

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
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { postVariantId: 'v-1', organizationId: 'org-1' } }),
    );
  });

  it('only looks at claims old enough to have been abandoned', async () => {
    findMany.mockResolvedValue([]);
    await reconcileStuckJobs('corr-1');

    const where = findMany.mock.calls[0]?.[0]?.where as {
      status: string;
      claimedAt: { lt: Date };
    };
    expect(where.status).toBe('PUBLISHING');
    expect(Date.now() - where.claimedAt.lt.getTime()).toBeGreaterThanOrEqual(15 * 60_000 - 1_000);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('carries on past a variant with no publishing job', async () => {
    findMany.mockResolvedValue([
      { id: 'v-1', organizationId: 'org-1', socialAccountId: 'a-1', claimedAt, claimToken: 't' },
      { id: 'v-2', organizationId: 'org-1', socialAccountId: 'a-2', claimedAt, claimToken: 't' },
    ]);
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'job-2', idempotencyKey: 'key-2' });

    await reconcileStuckJobs('corr-1');

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[1]).toMatchObject({ postVariantId: 'v-2' });
  });
});
