import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantIsolationError, fixedClock, setClock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection, queueFor, redis } from '@orbit/queue';
import { CredentialCipher, registerProvider, resetRegistry } from '@orbit/providers';
import { MockProvider } from '@orbit/providers/mock';
import { processAnalytics } from '../processors/analytics.js';
import { FRESH_POST_AGE_MS, sweepAnalytics } from './sweep.js';

/**
 * Analytics ingestion against real Postgres, real Redis and the mock provider
 * (T3.1, T3.2).
 *
 * What matters here is not that a number arrives — a unit test can show that.
 * It is the three things that would quietly ruin a client report:
 *
 * 1. an unavailable metric is stored as **unavailable**, never as a zero;
 * 2. post history accumulates while account days are overwritten, because a
 *    report is built on the shape of the first and the latest of the second;
 * 3. the cadence is actually respected, so a 6-hourly poll does not become an
 *    hourly one and burn the app's shared Meta quota.
 */

const ORG = '018ffa00-0000-7000-8000-0000fa000001';
const ORG_B = '018ffb00-0000-7000-8000-0000fb000001';
const WS = '018ffa00-0000-7000-8000-0000fa000002';
const BRAND = '018ffa00-0000-7000-8000-0000fa000003';
const ACCOUNT = '018ffa00-0000-7000-8000-0000fa000004';
const POST = '018ffa00-0000-7000-8000-0000fa000005';
const VARIANT = '018ffa00-0000-7000-8000-0000fa000006';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1_000;

let restoreClock: (() => void) | undefined;

function jobFor(overrides: Record<string, unknown> = {}) {
  return {
    payload: {
      organizationId: ORG,
      correlationId: 'itest-analytics',
      socialAccountId: ACCOUNT,
      ...overrides,
    },
    attempt: 1,
    jobId: 'queue-job-analytics-1',
    correlationId: 'itest-analytics',
  } as never;
}

async function flushRedis() {
  const connection = redis();
  for (const pattern of ['bull:*', 'ratelimit:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await connection.del(...keys);
    } while (cursor !== '0');
  }
}

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';

  resetRegistry();
  registerProvider(new MockProvider());

  for (const [id, slug] of [
    [ORG, 't31'],
    [ORG_B, 't31b'],
  ] as const) {
    await platformDb.organization.upsert({
      where: { id },
      update: {},
      create: { id, name: slug, slug, timezone: 'UTC' },
    });
  }

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
    update: { status: 'ACTIVE' },
    create: {
      id: ACCOUNT,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      platform: 'FACEBOOK',
      externalId: 'mock-page-1',
      displayName: 'Mock Page',
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });

  const cipher = new CredentialCipher();
  const sealed = cipher.seal('mock-access-token', {
    organizationId: ORG,
    socialAccountId: ACCOUNT,
  });

  await platformDb.socialCredential.upsert({
    where: { socialAccountId: ACCOUNT },
    update: {},
    create: {
      organizationId: ORG,
      socialAccountId: ACCOUNT,
      accessTokenCiphertext: new Uint8Array(sealed.ciphertext),
      accessTokenIv: new Uint8Array(sealed.iv),
      accessTokenAuthTag: new Uint8Array(sealed.authTag),
      keyVersion: sealed.keyVersion,
      scopes: ['mock_publish'],
    },
  });
});

afterAll(async () => {
  restoreClock?.();
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
  await closeQueues();
  await closeSharedConnection();
});

beforeEach(async () => {
  restoreClock?.();
  restoreClock = setClock(fixedClock(NOW));

  await flushRedis();
  await platformDb.postAnalytics.deleteMany({ where: { organizationId: ORG } });
  await platformDb.analyticsSnapshot.deleteMany({ where: { organizationId: ORG } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: ORG } });
  await platformDb.post.deleteMany({ where: { organizationId: ORG } });

  await platformDb.post.create({
    data: {
      id: POST,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      body: 'Measured post',
      status: 'PUBLISHED',
      // The DB insists a PUBLISHED post carries its timestamp, which is the
      // constraint doing its job — a published thing without a time is not a
      // state analytics should ever be reading from.
      publishedAt: NOW,
    },
  });
});

async function seedVariant(publishedAt: Date, status = 'PUBLISHED') {
  await platformDb.postVariant.create({
    data: {
      id: VARIANT,
      organizationId: ORG,
      postId: POST,
      socialAccountId: ACCOUNT,
      platform: 'FACEBOOK',
      body: 'Measured post',
      status: status as never,
      externalPostId: 'mock-post-1',
      publishedAt,
    },
  });
}

describe('post analytics ingestion', () => {
  it('stores the metrics and the availability map together', async () => {
    await seedVariant(NOW);

    await processAnalytics(jobFor({ postVariantId: VARIANT }));

    const row = await platformDb.postAnalytics.findFirstOrThrow({
      where: { postVariantId: VARIANT },
    });

    expect(row.metrics).toMatchObject({ views: expect.any(Number) });
    expect(row.providerApiVersion).toBeTruthy();
  });

  /**
   * The single most damaging thing this could get wrong. A withdrawn metric
   * charted as 0 tells a client nobody engaged, which is a different statement
   * from "Facebook stopped reporting this" — and it is one they will act on.
   */
  it('records a withdrawn metric as DEPRECATED and never as zero', async () => {
    await seedVariant(NOW);

    await processAnalytics(jobFor({ postVariantId: VARIANT }));

    const row = await platformDb.postAnalytics.findFirstOrThrow({
      where: { postVariantId: VARIANT },
    });

    expect((row.availability as Record<string, string>)['impressions']).toBe('DEPRECATED');
    expect((row.metrics as Record<string, number>)['impressions']).toBeUndefined();
  });

  it('keeps every capture, so a metric has a history rather than a latest', async () => {
    await seedVariant(NOW);

    await processAnalytics(jobFor({ postVariantId: VARIANT }));

    restoreClock?.();
    restoreClock = setClock(fixedClock(new Date(NOW.getTime() + 6 * HOUR)));
    await processAnalytics(jobFor({ postVariantId: VARIANT }));

    expect(await platformDb.postAnalytics.count({ where: { postVariantId: VARIANT } })).toBe(2);
  });

  it('does not ask the platform about a post that never published', async () => {
    await seedVariant(NOW, 'DRAFT');

    await processAnalytics(jobFor({ postVariantId: VARIANT }));

    expect(await platformDb.postAnalytics.count({ where: { postVariantId: VARIANT } })).toBe(0);
  });

  it('refuses a payload that names a different tenant than the row', async () => {
    await seedVariant(NOW);

    await expect(
      processAnalytics(jobFor({ postVariantId: VARIANT, organizationId: ORG_B })),
    ).rejects.toBeInstanceOf(TenantIsolationError);
  });
});

describe('account analytics ingestion', () => {
  /**
   * The opposite choice from posts, and deliberate: a day's figure is still
   * moving while the day is open, so two rows for one date would double every
   * total built on it.
   */
  it('overwrites the day rather than accumulating rows', async () => {
    await processAnalytics(jobFor());
    await processAnalytics(jobFor());

    expect(await platformDb.analyticsSnapshot.count({ where: { socialAccountId: ACCOUNT } })).toBe(
      1,
    );
  });

  it('stores the day bucket in UTC', async () => {
    await processAnalytics(jobFor());

    const row = await platformDb.analyticsSnapshot.findFirstOrThrow({
      where: { socialAccountId: ACCOUNT },
    });

    expect(row.date.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });
});

describe('the sweep and its cadence', () => {
  async function queued() {
    const queue = queueFor('analytics');
    return (await queue.getJobs(['waiting', 'delayed', 'active', 'completed'])).length;
  }

  it('queues a published post that has never been measured', async () => {
    await seedVariant(NOW);

    const result = await sweepAnalytics('itest-sweep');

    expect(result.posts).toBe(1);
    expect(await queued()).toBeGreaterThan(0);
  });

  /**
   * Meta's rate limit is per *app*, so a poll one agency makes is quota another
   * agency's publish cannot use. A cadence that silently collapsed to hourly
   * would not fail — it would just quietly spend everyone's budget.
   */
  it('leaves a recent post alone until its six hours are up', async () => {
    await seedVariant(NOW);
    await platformDb.postAnalytics.create({
      data: {
        organizationId: ORG,
        postVariantId: VARIANT,
        capturedAt: new Date(NOW.getTime() - 2 * HOUR),
        metrics: {},
        availability: {},
        providerApiVersion: 'mock',
      },
    });

    expect((await sweepAnalytics('itest-sweep')).posts).toBe(0);

    restoreClock?.();
    restoreClock = setClock(fixedClock(new Date(NOW.getTime() + 5 * HOUR)));

    expect((await sweepAnalytics('itest-sweep')).posts).toBe(1);
  });

  it('puts an older post on the daily cadence, not the six-hourly one', async () => {
    const old = new Date(NOW.getTime() - FRESH_POST_AGE_MS - HOUR);
    await seedVariant(old);
    await platformDb.postAnalytics.create({
      data: {
        organizationId: ORG,
        postVariantId: VARIANT,
        capturedAt: new Date(NOW.getTime() - 8 * HOUR),
        metrics: {},
        availability: {},
        providerApiVersion: 'mock',
      },
    });

    // Eight hours is past the fresh cadence and short of the mature one.
    expect((await sweepAnalytics('itest-sweep')).posts).toBe(0);
  });

  /**
   * Asserted on *this* account rather than on the sweep's total: the sweep is
   * platform-wide by design, so any other seed data in the database counts
   * toward that total and a global assertion would be measuring the fixture.
   */
  it('queues an account whose day bucket is missing, and stops once it has one', async () => {
    async function accountJobIds() {
      const jobs = await queueFor('analytics').getJobs([
        'waiting',
        'delayed',
        'active',
        'completed',
      ]);
      return jobs.map((job) => job.id).filter((id) => id?.includes(ACCOUNT));
    }

    await sweepAnalytics('itest-sweep');
    expect(await accountJobIds()).toHaveLength(1);

    await processAnalytics(jobFor());
    await flushRedis();

    await sweepAnalytics('itest-sweep');
    expect(await accountJobIds()).toHaveLength(0);
  });

  it('ignores posts older than the 30-day backfill window', async () => {
    await seedVariant(new Date(NOW.getTime() - 31 * 24 * HOUR));

    expect((await sweepAnalytics('itest-sweep')).posts).toBe(0);
  });
});
