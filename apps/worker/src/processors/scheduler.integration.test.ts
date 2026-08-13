import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contentHash, fixedClock, publishIdempotencyKey, setClock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection, queueFor, redis } from '@orbit/queue';
import { reportStaleSchedules, sweepDueVariants } from './scheduler.js';

/**
 * The scheduler sweep against the real database and real Redis (T1.12).
 *
 * What this proves that a unit test cannot: that the sweep's SQL actually
 * selects what it should, that the `PublishingJob` unique constraint really
 * makes a second sweep a no-op, and that a duplicate sweep produces **one**
 * queued job — which is the property the whole no-double-publishing design
 * rests on at this layer.
 */

const ORG = '018fe100-0000-7000-8000-0000e1000001';
const WS = '018fe100-0000-7000-8000-0000e1000002';
const BRAND = '018fe100-0000-7000-8000-0000e1000003';
const ACCOUNT = '018fe100-0000-7000-8000-0000e1000004';
const POST = '018fe100-0000-7000-8000-0000e1000005';
const VARIANT = '018fe100-0000-7000-8000-0000e1000006';

const NOW = new Date('2026-06-15T12:00:00.000Z');

let restoreClock: (() => void) | undefined;

async function flushQueues() {
  const connection = redis();
  let cursor = '0';
  do {
    const [next, keys] = await connection.scan(cursor, 'MATCH', 'bull:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await connection.del(...keys);
  } while (cursor !== '0');
}

/** A scheduled variant, written directly so the sweep is what is under test. */
async function seedScheduled(options: {
  scheduledFor: Date;
  postStatus?: 'SCHEDULED' | 'DRAFT';
  variantStatus?: 'SCHEDULED' | 'DRAFT';
  withHash?: boolean;
}) {
  const hash = contentHash({ body: 'A perfectly ordinary announcement.' });

  await platformDb.post.create({
    data: {
      id: POST,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      body: 'A perfectly ordinary announcement.',
      status: options.postStatus ?? 'SCHEDULED',
      scheduledFor: options.scheduledFor,
      timezone: 'UTC',
    },
  });

  await platformDb.postVariant.create({
    data: {
      id: VARIANT,
      organizationId: ORG,
      postId: POST,
      socialAccountId: ACCOUNT,
      platform: 'FACEBOOK',
      body: '',
      status: options.variantStatus ?? 'SCHEDULED',
      scheduledFor: options.scheduledFor,
      ...((options.withHash ?? true) ? { contentHash: hash } : {}),
    },
  });

  return { hash };
}

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';

  await platformDb.organization.upsert({
    where: { id: ORG },
    update: {},
    create: { id: ORG, name: 't12sweep', slug: 't12sweep', timezone: 'UTC' },
  });
  await platformDb.workspace.upsert({
    where: { id: WS },
    update: {},
    create: { id: WS, organizationId: ORG, name: 'ws', slug: 'ws', timezone: 'UTC' },
  });
  await platformDb.brand.upsert({
    where: { id: BRAND },
    update: {},
    create: { id: BRAND, organizationId: ORG, workspaceId: WS, name: 'b', slug: 'b' },
  });
  await platformDb.socialAccount.upsert({
    where: { id: ACCOUNT },
    update: {},
    create: {
      id: ACCOUNT,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      platform: 'FACEBOOK',
      externalId: 'ext-sweep',
      displayName: 'Sweep Page',
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });
});

beforeEach(async () => {
  restoreClock = setClock(fixedClock(NOW));
  await platformDb.publishingJob.deleteMany({ where: { organizationId: ORG } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: ORG } });
  await platformDb.post.deleteMany({ where: { organizationId: ORG } });
  await flushQueues();
});

afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
});

afterAll(async () => {
  await flushQueues();
  await platformDb.organization.deleteMany({ where: { id: ORG } });
  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

describe('the sweep', () => {
  it('picks up a variant that is due', async () => {
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 1_000) });

    const result = await sweepDueVariants('test-sweep');

    expect(result).toMatchObject({ due: 1, enqueued: 1, failed: 0 });
  });

  it('picks up a variant inside the tolerance window', async () => {
    // Assumption C10: ±60s. The sweep runs every 30s, so a variant due in 45s
    // is taken now rather than waiting for a sweep that lands after its time.
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() + 45_000) });

    expect(await sweepDueVariants('test-sweep')).toMatchObject({ due: 1, enqueued: 1 });
  });

  it('leaves a variant beyond the tolerance window alone', async () => {
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() + 300_000) });

    expect(await sweepDueVariants('test-sweep')).toMatchObject({ due: 0, enqueued: 0 });
  });

  it('ignores a variant whose post is no longer scheduled', async () => {
    // A variant left SCHEDULED on a post that was pulled back must not publish
    // on its own.
    await seedScheduled({
      scheduledFor: new Date(NOW.getTime() - 1_000),
      postStatus: 'DRAFT',
    });

    expect(await sweepDueVariants('test-sweep')).toMatchObject({ due: 0 });
  });

  it('ignores a variant that is not itself scheduled', async () => {
    await seedScheduled({
      scheduledFor: new Date(NOW.getTime() - 1_000),
      variantStatus: 'DRAFT',
    });

    expect(await sweepDueVariants('test-sweep')).toMatchObject({ due: 0 });
  });

  it('skips a variant whose account needs reconnecting, and counts it', async () => {
    // T1.7. Queueing it would spend a job, an attempt row and a log line to
    // reach the engine's own refusal — once every 30 seconds, per post.
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 1_000) });
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT },
      data: { status: 'NEEDS_RECONNECT' },
    });

    try {
      const result = await sweepDueVariants('test-sweep');

      expect(result).toMatchObject({ due: 0, enqueued: 0, paused: 1 });
      expect(await platformDb.publishingJob.count({ where: { organizationId: ORG } })).toBe(0);
    } finally {
      await platformDb.socialAccount.update({
        where: { id: ACCOUNT },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('leaves a paused variant scheduled, so reconnecting is all it takes', async () => {
    // Skipping is not cancelling. This is the property that makes the reconnect
    // flow a fix rather than a fresh start.
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 1_000) });
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT },
      data: { status: 'NEEDS_RECONNECT' },
    });

    await sweepDueVariants('test-sweep');

    const parked = await platformDb.postVariant.findUniqueOrThrow({ where: { id: VARIANT } });
    expect(parked.status).toBe('SCHEDULED');
    expect(parked.scheduledFor).toEqual(new Date(NOW.getTime() - 1_000));

    // Reconnected: the next sweep picks it up with nothing else to do.
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT },
      data: { status: 'ACTIVE' },
    });

    expect(await sweepDueVariants('test-sweep')).toMatchObject({ due: 1, enqueued: 1, paused: 0 });
  });

  it('refuses to enqueue a variant with no content hash', async () => {
    // No hash means no stable idempotency key, and without that a retry could
    // double-publish. Refusing is the safe answer.
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 1_000), withHash: false });

    const result = await sweepDueVariants('test-sweep');

    expect(result).toMatchObject({ due: 1, enqueued: 0, failed: 1 });
    expect(await platformDb.publishingJob.count({ where: { organizationId: ORG } })).toBe(0);
  });
});

describe('idempotency', () => {
  it('creates one publishing job and one queued job', async () => {
    const { hash } = await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 1_000) });

    await sweepDueVariants('test-sweep');

    const jobs = await platformDb.publishingJob.findMany({ where: { organizationId: ORG } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.state).toBe('QUEUED');
    expect(jobs[0]?.idempotencyKey).toBe(
      publishIdempotencyKey({
        postVariantId: VARIANT,
        scheduledFor: new Date(NOW.getTime() - 1_000),
        contentHash: hash,
      }),
    );

    const counts = await queueFor('publish').getJobCounts('waiting', 'delayed');
    expect((counts.waiting ?? 0) + (counts.delayed ?? 0)).toBe(1);
  });

  it('sweeping twice enqueues once', async () => {
    // The property the no-double-publishing design rests on at this layer.
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 1_000) });

    const first = await sweepDueVariants('test-sweep');
    const second = await sweepDueVariants('test-sweep');

    expect(first.enqueued).toBe(1);
    expect(second.enqueued).toBe(0);
    expect(second.duplicate).toBe(1);

    expect(await platformDb.publishingJob.count({ where: { organizationId: ORG } })).toBe(1);

    const counts = await queueFor('publish').getJobCounts('waiting', 'delayed');
    expect((counts.waiting ?? 0) + (counts.delayed ?? 0)).toBe(1);
  });

  it('two concurrent sweeps still produce one job', async () => {
    // Several worker instances sweep in parallel by design.
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 1_000) });

    const results = await Promise.all([
      sweepDueVariants('sweep-a'),
      sweepDueVariants('sweep-b'),
      sweepDueVariants('sweep-c'),
    ]);

    const enqueued = results.reduce((total, result) => total + result.enqueued, 0);
    expect(enqueued).toBe(1);

    expect(await platformDb.publishingJob.count({ where: { organizationId: ORG } })).toBe(1);

    const counts = await queueFor('publish').getJobCounts('waiting', 'delayed');
    expect((counts.waiting ?? 0) + (counts.delayed ?? 0)).toBe(1);
  });

  it('a rescheduled variant gets a new key and a new job', async () => {
    // Rescheduling is a genuinely different publish; it must not collapse onto
    // the job queued for the old time.
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 1_000) });
    await sweepDueVariants('test-sweep');

    const moved = new Date(NOW.getTime() - 500);
    await platformDb.postVariant.update({
      where: { id: VARIANT },
      data: { scheduledFor: moved },
    });
    await platformDb.post.update({ where: { id: POST }, data: { scheduledFor: moved } });

    const second = await sweepDueVariants('test-sweep');

    expect(second.enqueued).toBe(1);
    expect(await platformDb.publishingJob.count({ where: { organizationId: ORG } })).toBe(2);
  });

  it('never puts tenant-identifying content in the payload', async () => {
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 1_000) });
    await sweepDueVariants('test-sweep');

    const [job] = await queueFor('publish').getWaiting(0, 0);
    const payload = JSON.stringify(job?.data ?? {});

    // Identifiers only: no bodies, no tokens. A job queued before an edit must
    // not be able to publish the stale copy either.
    expect(payload).not.toContain('A perfectly ordinary announcement.');
    expect(payload).not.toContain('accessToken');
    expect(job?.data).toMatchObject({ organizationId: ORG, postVariantId: VARIANT });
  });
});

describe('stale schedules', () => {
  it('does not report a merely late post', async () => {
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 60_000) });

    expect(await reportStaleSchedules()).toBe(0);
  });

  it('reports a post hours past its time', async () => {
    // A "good morning" going out at 4pm because workers were down is worse than
    // not going out; these wait for a human.
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 6 * 3_600_000) });

    expect(await reportStaleSchedules()).toBe(1);
  });

  it('leaves a stale post SCHEDULED rather than deciding for the user', async () => {
    await seedScheduled({ scheduledFor: new Date(NOW.getTime() - 6 * 3_600_000) });

    await reportStaleSchedules();

    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(variant?.status).toBe('SCHEDULED');
  });
});
