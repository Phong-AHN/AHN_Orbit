import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, setClock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { analyticsCutoff, sweepRetention } from './retention.js';
import type * as OrbitStorageModule from '@orbit/storage';

type OrbitStorage = typeof OrbitStorageModule;

/**
 * Retention and cleanup (T3.6).
 *
 * This is the only code in the product that deletes data nobody asked to
 * delete, so the tests are written from the same direction the implementation
 * is: proving what is **kept** matters at least as much as proving what goes.
 *
 * S3 is stubbed. What is being tested is the *ordering* — object before row —
 * and what happens when storage refuses, neither of which needs a bucket.
 */

const ORG_A = '018f0b00-0000-7000-8000-000b00000001';
const ORG_B = '018f0c00-0000-7000-8000-000c00000001';
const WS_A = '018f0b00-0000-7000-8000-000b00000002';
const WS_B = '018f0c00-0000-7000-8000-000c00000002';
const BRAND_A = '018f0b00-0000-7000-8000-000b00000003';
const BRAND_B = '018f0c00-0000-7000-8000-000c00000003';
const ACCOUNT_A = '018f0b00-0000-7000-8000-000b00000004';
const ACCOUNT_B = '018f0c00-0000-7000-8000-000c00000004';

/** Cutoff for this NOW is 2025-05-01: thirteen months back, first of the month. */
const NOW = new Date('2026-06-15T12:00:00.000Z');

let restoreClock: (() => void) | undefined;

const deletedKeys: string[] = [];
let storageFails = false;

vi.mock('@orbit/storage', async (importOriginal) => {
  const actual = await importOriginal<OrbitStorage>();
  return {
    ...actual,
    deleteObject: vi.fn(async (key: string) => {
      if (storageFails) throw new Error('storage unreachable');
      deletedKeys.push(key);
    }),
  };
});

async function seedTenant(org: string, ws: string, brand: string, account: string, slug: string) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: slug, slug, timezone: 'UTC' },
  });
  await platformDb.workspace.upsert({
    where: { id: ws },
    update: {},
    create: { id: ws, organizationId: org, name: slug, slug, timezone: 'UTC' },
  });
  await platformDb.brand.upsert({
    where: { id: brand },
    update: {},
    create: { id: brand, organizationId: org, workspaceId: ws, name: slug, slug },
  });
  await platformDb.socialAccount.upsert({
    where: { id: account },
    update: {},
    create: {
      id: account,
      organizationId: org,
      workspaceId: ws,
      brandId: brand,
      platform: 'FACEBOOK',
      externalId: `ext-${slug}`,
      displayName: slug,
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });
}

/** A published post with one analytics capture at a chosen time. */
async function seedCapture(org: string, ws: string, brand: string, account: string, at: Date) {
  const post = await platformDb.post.create({
    data: {
      organizationId: org,
      workspaceId: ws,
      brandId: brand,
      body: 'Measured',
      status: 'PUBLISHED',
      publishedAt: at,
    },
  });

  const variant = await platformDb.postVariant.create({
    data: {
      organizationId: org,
      postId: post.id,
      socialAccountId: account,
      platform: 'FACEBOOK',
      body: 'Measured',
      status: 'PUBLISHED',
      externalPostId: `ext-${post.id.slice(-8)}`,
      publishedAt: at,
    },
  });

  await platformDb.postAnalytics.create({
    data: {
      organizationId: org,
      postVariantId: variant.id,
      capturedAt: at,
      metrics: { post_media_view: 1 },
      availability: {},
      providerApiVersion: 'v25.0',
    },
  });

  return { postId: post.id, variantId: variant.id };
}

async function seedSnapshot(org: string, account: string, day: string) {
  await platformDb.analyticsSnapshot.create({
    data: {
      organizationId: org,
      socialAccountId: account,
      date: new Date(`${day}T00:00:00.000Z`),
      metrics: { page_media_view: 1 },
      availability: {},
      providerApiVersion: 'v25.0',
    },
  });
}

async function seedReport(org: string, expiresAt: Date, storageKey: string | null) {
  return platformDb.report.create({
    data: {
      organizationId: org,
      status: storageKey ? 'READY' : 'QUEUED',
      format: 'CSV',
      parameters: { from: '2026-05-01', to: '2026-05-31' },
      expiresAt,
      ...(storageKey ? { storageKey } : {}),
    },
  });
}

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';

  await seedTenant(ORG_A, WS_A, BRAND_A, ACCOUNT_A, 'ret-a');
  await seedTenant(ORG_B, WS_B, BRAND_B, ACCOUNT_B, 'ret-b');
});

afterAll(async () => {
  restoreClock?.();
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
});

beforeEach(async () => {
  restoreClock?.();
  restoreClock = setClock(fixedClock(NOW));

  deletedKeys.length = 0;
  storageFails = false;

  for (const org of [ORG_A, ORG_B]) {
    await platformDb.auditLog.deleteMany({ where: { organizationId: org } });
    await platformDb.report.deleteMany({ where: { organizationId: org } });
    await platformDb.postAnalytics.deleteMany({ where: { organizationId: org } });
    await platformDb.analyticsSnapshot.deleteMany({ where: { organizationId: org } });
    await platformDb.postVariant.deleteMany({ where: { organizationId: org } });
    await platformDb.post.deleteMany({ where: { organizationId: org } });
  }
});

describe('the cutoff', () => {
  it('is the first of the month, thirteen months back', () => {
    expect(analyticsCutoff(NOW).toISOString()).toBe('2025-05-01T00:00:00.000Z');
  });

  /**
   * Naive month arithmetic on a 31st lands on a day that does not exist and
   * rolls *forward*, which would delete more than intended. Anchoring to the
   * first of the month can only ever round toward keeping data.
   */
  it('does not roll forward when the day of the month does not exist thirteen months back', () => {
    expect(analyticsCutoff(new Date('2026-03-31T23:59:59.000Z')).toISOString()).toBe(
      '2025-02-01T00:00:00.000Z',
    );
  });
});

describe('analytics retention', () => {
  it('keeps a capture exactly on the retention boundary', async () => {
    // Precisely at the cutoff, which is inside the window: the predicate is
    // strictly older-than, so the boundary itself survives.
    await seedCapture(ORG_A, WS_A, BRAND_A, ACCOUNT_A, new Date('2025-05-01T00:00:00.000Z'));

    await sweepRetention('itest-retention');

    expect(await platformDb.postAnalytics.count({ where: { organizationId: ORG_A } })).toBe(1);
  });

  it('keeps a capture inside the window', async () => {
    await seedCapture(ORG_A, WS_A, BRAND_A, ACCOUNT_A, new Date('2025-05-02T00:00:00.000Z'));

    await sweepRetention('itest-retention');

    expect(await platformDb.postAnalytics.count({ where: { organizationId: ORG_A } })).toBe(1);
  });

  it('deletes a capture one millisecond beyond the window', async () => {
    await seedCapture(ORG_A, WS_A, BRAND_A, ACCOUNT_A, new Date('2025-04-30T23:59:59.999Z'));

    const result = await sweepRetention('itest-retention');

    expect(result.postAnalytics).toBe(1);
    expect(await platformDb.postAnalytics.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('deletes an account snapshot beyond the window and keeps one inside it', async () => {
    await seedSnapshot(ORG_A, ACCOUNT_A, '2025-04-15');
    await seedSnapshot(ORG_A, ACCOUNT_A, '2025-05-15');

    const result = await sweepRetention('itest-retention');

    expect(result.snapshots).toBe(1);
    const left = await platformDb.analyticsSnapshot.findMany({ where: { organizationId: ORG_A } });
    expect(left).toHaveLength(1);
    expect(left[0]?.date.toISOString()).toBe('2025-05-15T00:00:00.000Z');
  });

  /**
   * The thing that must never happen. Analytics ageing out is routine; the post
   * that was published is the agency's record of work done for a client.
   */
  it('never deletes the post or the variant whose analytics it removed', async () => {
    const { postId, variantId } = await seedCapture(
      ORG_A,
      WS_A,
      BRAND_A,
      ACCOUNT_A,
      new Date('2024-01-01T00:00:00.000Z'),
    );

    await sweepRetention('itest-retention');

    expect(await platformDb.post.findUnique({ where: { id: postId } })).not.toBeNull();
    expect(await platformDb.postVariant.findUnique({ where: { id: variantId } })).not.toBeNull();
  });

  it('leaves the audit log alone, including rows older than the window', async () => {
    await platformDb.auditLog.create({
      data: {
        organizationId: ORG_A,
        actorType: 'USER',
        action: 'post.created',
        resourceType: 'Post',
        createdAt: new Date('2023-01-01T00:00:00.000Z'),
      },
    });
    await seedCapture(ORG_A, WS_A, BRAND_A, ACCOUNT_A, new Date('2024-01-01T00:00:00.000Z'));

    await sweepRetention('itest-retention');

    expect(
      await platformDb.auditLog.count({ where: { organizationId: ORG_A, action: 'post.created' } }),
    ).toBe(1);
  });

  it('records what it removed on the tenant own trail', async () => {
    await seedCapture(ORG_A, WS_A, BRAND_A, ACCOUNT_A, new Date('2024-01-01T00:00:00.000Z'));

    await sweepRetention('itest-retention');

    const entry = await platformDb.auditLog.findFirst({
      where: { organizationId: ORG_A, action: 'retention.swept' },
    });

    expect(entry).not.toBeNull();
    expect(entry?.after).toMatchObject({ postAnalytics: 1 });
  });
});

describe('expired reports', () => {
  it('removes the object and then the row', async () => {
    const report = await seedReport(
      ORG_A,
      new Date(NOW.getTime() - 1_000),
      `org/${ORG_A}/2026/05/report.csv`,
    );

    const result = await sweepRetention('itest-retention');

    expect(result.reports).toBe(1);
    expect(deletedKeys).toEqual([`org/${ORG_A}/2026/05/report.csv`]);
    expect(await platformDb.report.findUnique({ where: { id: report.id } })).toBeNull();
  });

  it('keeps a report that has not expired', async () => {
    const report = await seedReport(
      ORG_A,
      new Date(NOW.getTime() + 60_000),
      `org/${ORG_A}/live.csv`,
    );

    await sweepRetention('itest-retention');

    expect(await platformDb.report.findUnique({ where: { id: report.id } })).not.toBeNull();
    expect(deletedKeys).toHaveLength(0);
  });

  it('removes an expired report that never got as far as a file', async () => {
    const report = await seedReport(ORG_A, new Date(NOW.getTime() - 1_000), null);

    const result = await sweepRetention('itest-retention');

    expect(result.reports).toBe(1);
    expect(await platformDb.report.findUnique({ where: { id: report.id } })).toBeNull();
  });

  /**
   * S3 returns success for a key that is already gone, so this is the harsher
   * case: storage itself is unreachable. The run must continue and the row must
   * survive — it is the only record that the object may still exist, and losing
   * it would orphan the object permanently.
   */
  it('survives storage being unreachable, keeps the row, and still sweeps analytics', async () => {
    storageFails = true;

    const report = await seedReport(
      ORG_A,
      new Date(NOW.getTime() - 1_000),
      `org/${ORG_A}/unreachable.csv`,
    );
    await seedCapture(ORG_A, WS_A, BRAND_A, ACCOUNT_A, new Date('2024-01-01T00:00:00.000Z'));

    const result = await sweepRetention('itest-retention');

    expect(result.storageFailures).toBe(1);
    expect(result.reports).toBe(0);
    expect(await platformDb.report.findUnique({ where: { id: report.id } })).not.toBeNull();

    // The rest of the sweep was not abandoned.
    expect(result.postAnalytics).toBe(1);
  });

  it('cleans up on the next pass once storage recovers', async () => {
    storageFails = true;
    const report = await seedReport(
      ORG_A,
      new Date(NOW.getTime() - 1_000),
      `org/${ORG_A}/later.csv`,
    );
    await sweepRetention('itest-retention');

    storageFails = false;
    const second = await sweepRetention('itest-retention');

    expect(second.reports).toBe(1);
    expect(await platformDb.report.findUnique({ where: { id: report.id } })).toBeNull();
  });
});

describe('safety', () => {
  /**
   * Every delete runs inside a tenant context, so a mistake in a predicate can
   * only fail to delete — it cannot reach across the boundary.
   */
  it('never touches another tenant data', async () => {
    await seedCapture(ORG_B, WS_B, BRAND_B, ACCOUNT_B, new Date('2024-01-01T00:00:00.000Z'));
    await seedSnapshot(ORG_B, ACCOUNT_B, '2024-01-01');
    const theirReport = await seedReport(
      ORG_B,
      new Date(NOW.getTime() - 1_000),
      `org/${ORG_B}/theirs.csv`,
    );

    // Org A has nothing expired at all.
    await seedCapture(ORG_A, WS_A, BRAND_A, ACCOUNT_A, new Date('2026-06-01T00:00:00.000Z'));

    await sweepRetention('itest-retention');

    // A's fresh data survives, and B's expired data was swept in B's own
    // context — never as a side effect of visiting A.
    expect(await platformDb.postAnalytics.count({ where: { organizationId: ORG_A } })).toBe(1);
    expect(await platformDb.postAnalytics.count({ where: { organizationId: ORG_B } })).toBe(0);
    expect(await platformDb.report.findUnique({ where: { id: theirReport.id } })).toBeNull();

    // And A was never even visited: nothing of A's was in scope.
    expect(
      await platformDb.auditLog.count({
        where: { organizationId: ORG_A, action: 'retention.swept' },
      }),
    ).toBe(0);
  });

  it('is safe to run twice', async () => {
    await seedCapture(ORG_A, WS_A, BRAND_A, ACCOUNT_A, new Date('2024-01-01T00:00:00.000Z'));
    await seedSnapshot(ORG_A, ACCOUNT_A, '2024-01-01');
    await seedReport(ORG_A, new Date(NOW.getTime() - 1_000), `org/${ORG_A}/twice.csv`);

    const first = await sweepRetention('itest-retention');
    const second = await sweepRetention('itest-retention');

    expect(first).toMatchObject({ postAnalytics: 1, snapshots: 1, reports: 1 });
    expect(second).toMatchObject({
      organizations: 0,
      postAnalytics: 0,
      snapshots: 0,
      reports: 0,
    });

    // And the second pass wrote no audit row, because it did nothing.
    expect(
      await platformDb.auditLog.count({
        where: { organizationId: ORG_A, action: 'retention.swept' },
      }),
    ).toBe(1);
  });

  it('does nothing at all when nothing has expired', async () => {
    await seedCapture(ORG_A, WS_A, BRAND_A, ACCOUNT_A, new Date('2026-06-01T00:00:00.000Z'));

    const result = await sweepRetention('itest-retention');

    expect(result).toEqual({
      organizations: 0,
      postAnalytics: 0,
      snapshots: 0,
      reports: 0,
      storageFailures: 0,
    });
  });
});
