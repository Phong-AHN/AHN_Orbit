import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantContext } from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { getAccountAnalytics, getAnalyticsOverview, listPostAnalytics } from './service';

/**
 * Reading analytics, against the real database (T3.3).
 *
 * The properties that matter are the ones that would show a client the wrong
 * number: that another tenant's figures are invisible even by exact id, that a
 * workspace-scoped reader is confined, and — most of all — that a metric which
 * is unavailable somewhere is never quietly folded into a total. A partial sum
 * presented as a total is worse than no number at all, because nothing about it
 * looks wrong.
 */

const ORG_A = '018ffc00-0000-7000-8000-0000fc000001';
const ORG_B = '018ffd00-0000-7000-8000-0000fd000001';
const WS_A1 = '018ffc00-0000-7000-8000-0000fc000002';
const WS_A2 = '018ffc00-0000-7000-8000-0000fc000003';
const BRAND_A1 = '018ffc00-0000-7000-8000-0000fc000004';
const BRAND_A2 = '018ffc00-0000-7000-8000-0000fc000005';
const ACCOUNT_A1 = '018ffc00-0000-7000-8000-0000fc000006';
const ACCOUNT_A2 = '018ffc00-0000-7000-8000-0000fc000007';
const WS_B = '018ffd00-0000-7000-8000-0000fd000002';
const BRAND_B = '018ffd00-0000-7000-8000-0000fd000003';
const ACCOUNT_B = '018ffd00-0000-7000-8000-0000fd000004';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const RANGE = { from: new Date('2026-05-16T00:00:00.000Z'), to: NOW };

let ownerA: TenantContext;
let managerA: TenantContext;
let ownerB: TenantContext;

async function seedOrg(org: string, slug: string, workspaces: string[]) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: slug, slug, timezone: 'UTC' },
  });

  for (const [index, ws] of workspaces.entries()) {
    await platformDb.workspace.upsert({
      where: { id: ws },
      update: {},
      create: {
        id: ws,
        organizationId: org,
        name: `${slug}-${index}`,
        slug: `${slug}-${index}`,
        timezone: 'UTC',
      },
    });
  }
}

async function seedBrandAndAccount(org: string, ws: string, brand: string, account: string) {
  await platformDb.brand.upsert({
    where: { id: brand },
    update: {},
    create: { id: brand, organizationId: org, workspaceId: ws, name: brand, slug: brand },
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
      externalId: `ext-${account}`,
      displayName: `Page ${account.slice(-4)}`,
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });
}

async function member(
  org: string,
  email: string,
  role: 'OWNER' | 'ACCOUNT_MANAGER',
  workspaceIds: string[],
) {
  const identity = await devIdentityProvider.verifyIdToken(`dev:${email}`);
  const user = await resolveUser(identity);

  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId: user.id } },
    update: { role },
    create: { organizationId: org, userId: user.id, role, status: 'ACTIVE' },
  });

  for (const workspaceId of workspaceIds) {
    await platformDb.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      update: {},
      create: { organizationId: org, workspaceId, userId: user.id, role: 'MANAGER' },
    });
  }

  const { ctx } = await resolveTenantContext(user, org, 'itest-analytics-read');
  return ctx;
}

/** A published variant with one capture on it. */
async function seedMeasuredPost(input: {
  org: string;
  ws: string;
  brand: string;
  account: string;
  metrics: Record<string, number>;
  availability: Record<string, string>;
}) {
  const post = await platformDb.post.create({
    data: {
      organizationId: input.org,
      workspaceId: input.ws,
      brandId: input.brand,
      body: 'Measured',
      status: 'PUBLISHED',
      publishedAt: NOW,
    },
  });

  const variant = await platformDb.postVariant.create({
    data: {
      organizationId: input.org,
      postId: post.id,
      socialAccountId: input.account,
      platform: 'FACEBOOK',
      body: 'Measured',
      status: 'PUBLISHED',
      externalPostId: `ext-post-${post.id.slice(-6)}`,
      publishedAt: NOW,
    },
  });

  await platformDb.postAnalytics.create({
    data: {
      organizationId: input.org,
      postVariantId: variant.id,
      capturedAt: NOW,
      metrics: input.metrics,
      availability: input.availability,
      providerApiVersion: 'v25.0',
    },
  });

  return { postId: post.id, variantId: variant.id };
}

beforeAll(async () => {
  await seedOrg(ORG_A, 'an-a', [WS_A1, WS_A2]);
  await seedOrg(ORG_B, 'an-b', [WS_B]);

  await seedBrandAndAccount(ORG_A, WS_A1, BRAND_A1, ACCOUNT_A1);
  await seedBrandAndAccount(ORG_A, WS_A2, BRAND_A2, ACCOUNT_A2);
  await seedBrandAndAccount(ORG_B, WS_B, BRAND_B, ACCOUNT_B);

  ownerA = await member(ORG_A, 'owner@an-a.test', 'OWNER', []);
  managerA = await member(ORG_A, 'manager@an-a.test', 'ACCOUNT_MANAGER', [WS_A1]);
  ownerB = await member(ORG_B, 'owner@an-b.test', 'OWNER', []);
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '.test' } } });
});

beforeEach(async () => {
  await platformDb.postAnalytics.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  });
  await platformDb.analyticsSnapshot.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  });
  await platformDb.post.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

describe('listPostAnalytics', () => {
  it('returns the latest reading for a published post', async () => {
    await seedMeasuredPost({
      org: ORG_A,
      ws: WS_A1,
      brand: BRAND_A1,
      account: ACCOUNT_A1,
      metrics: { post_media_view: 100 },
      availability: { post_media_view: 'AVAILABLE' },
    });

    const rows = await listPostAnalytics(ownerA, RANGE);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.reading?.metrics['post_media_view']).toBe(100);
  });

  it('never shows another tenant a reading', async () => {
    await seedMeasuredPost({
      org: ORG_B,
      ws: WS_B,
      brand: BRAND_B,
      account: ACCOUNT_B,
      metrics: { post_media_view: 999 },
      availability: { post_media_view: 'AVAILABLE' },
    });

    expect(await listPostAnalytics(ownerA, RANGE)).toHaveLength(0);
    expect(await listPostAnalytics(ownerB, RANGE)).toHaveLength(1);
  });

  it('confines a workspace-scoped reader to their own workspaces', async () => {
    await seedMeasuredPost({
      org: ORG_A,
      ws: WS_A1,
      brand: BRAND_A1,
      account: ACCOUNT_A1,
      metrics: { post_media_view: 10 },
      availability: { post_media_view: 'AVAILABLE' },
    });
    await seedMeasuredPost({
      org: ORG_A,
      ws: WS_A2,
      brand: BRAND_A2,
      account: ACCOUNT_A2,
      metrics: { post_media_view: 20 },
      availability: { post_media_view: 'AVAILABLE' },
    });

    expect(await listPostAnalytics(ownerA, RANGE)).toHaveLength(2);

    const theirs = await listPostAnalytics(managerA, RANGE);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.reading?.metrics['post_media_view']).toBe(10);
  });

  /**
   * A published post nobody has polled yet is a real and common state — the
   * sweep runs hourly, so there is always a window. `null` says "not measured",
   * which is a different thing from a reading full of zeroes.
   */
  it('reports a post with no capture as unread rather than as zero', async () => {
    const post = await platformDb.post.create({
      data: {
        organizationId: ORG_A,
        workspaceId: WS_A1,
        brandId: BRAND_A1,
        body: 'Fresh',
        status: 'PUBLISHED',
        publishedAt: NOW,
      },
    });
    await platformDb.postVariant.create({
      data: {
        organizationId: ORG_A,
        postId: post.id,
        socialAccountId: ACCOUNT_A1,
        platform: 'FACEBOOK',
        body: 'Fresh',
        status: 'PUBLISHED',
        externalPostId: 'ext-fresh',
        publishedAt: NOW,
      },
    });

    const rows = await listPostAnalytics(ownerA, RANGE);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.reading).toBeNull();
  });
});

describe('getAnalyticsOverview', () => {
  it('sums a metric that is available everywhere', async () => {
    for (const value of [10, 25]) {
      await seedMeasuredPost({
        org: ORG_A,
        ws: WS_A1,
        brand: BRAND_A1,
        account: ACCOUNT_A1,
        metrics: { post_media_view: value },
        availability: { post_media_view: 'AVAILABLE' },
      });
    }

    const overview = await getAnalyticsOverview(ownerA, RANGE);

    expect(overview.totals['post_media_view']).toBe(35);
    expect(overview.posts).toBe(2);
  });

  /**
   * The heart of §18. A metric Facebook withdrew must not be summed into a
   * total — a client reading "1,240 impressions" cannot tell that the figure
   * covers half their posts, and the number looks perfectly fine.
   */
  it('refuses to total a metric that is unavailable anywhere', async () => {
    await seedMeasuredPost({
      org: ORG_A,
      ws: WS_A1,
      brand: BRAND_A1,
      account: ACCOUNT_A1,
      metrics: { post_impressions: 500 },
      availability: { post_impressions: 'AVAILABLE' },
    });
    await seedMeasuredPost({
      org: ORG_A,
      ws: WS_A1,
      brand: BRAND_A1,
      account: ACCOUNT_A1,
      metrics: {},
      availability: { post_impressions: 'DEPRECATED' },
    });

    const overview = await getAnalyticsOverview(ownerA, RANGE);

    expect(overview.totals['post_impressions']).toBeUndefined();
    expect(overview.unavailable['post_impressions']).toBe('DEPRECATED');
  });

  it('counts the distinct accounts a window covers', async () => {
    await seedMeasuredPost({
      org: ORG_A,
      ws: WS_A1,
      brand: BRAND_A1,
      account: ACCOUNT_A1,
      metrics: { post_media_view: 1 },
      availability: { post_media_view: 'AVAILABLE' },
    });
    await seedMeasuredPost({
      org: ORG_A,
      ws: WS_A2,
      brand: BRAND_A2,
      account: ACCOUNT_A2,
      metrics: { post_media_view: 2 },
      availability: { post_media_view: 'AVAILABLE' },
    });

    expect((await getAnalyticsOverview(ownerA, RANGE)).accounts).toBe(2);
  });
});

describe('getAccountAnalytics', () => {
  async function seedSnapshot(org: string, account: string, day: string, views: number) {
    await platformDb.analyticsSnapshot.create({
      data: {
        organizationId: org,
        socialAccountId: account,
        date: new Date(`${day}T00:00:00.000Z`),
        metrics: { page_media_view: views },
        availability: { page_media_view: 'AVAILABLE', page_impressions: 'DEPRECATED' },
        providerApiVersion: 'v25.0',
      },
    });
  }

  it('returns the day series oldest first, which is chart order', async () => {
    await seedSnapshot(ORG_A, ACCOUNT_A1, '2026-06-02', 20);
    await seedSnapshot(ORG_A, ACCOUNT_A1, '2026-06-01', 10);

    const series = await getAccountAnalytics(ownerA, ACCOUNT_A1, RANGE);

    expect(series.map((row) => row.date.toISOString().slice(0, 10))).toEqual([
      '2026-06-01',
      '2026-06-02',
    ]);
  });

  it('carries availability on every point, so a gap is labelled not drawn as zero', async () => {
    await seedSnapshot(ORG_A, ACCOUNT_A1, '2026-06-01', 10);

    const series = await getAccountAnalytics(ownerA, ACCOUNT_A1, RANGE);

    expect((series[0]?.availability as Record<string, string>)['page_impressions']).toBe(
      'DEPRECATED',
    );
  });

  /**
   * The exact-id case. Knowing another tenant's account id must buy nothing —
   * and an empty series, rather than a 404, is what keeps it from confirming
   * that the id exists at all.
   */
  it('returns nothing for another tenant account, even by exact id', async () => {
    await seedSnapshot(ORG_B, ACCOUNT_B, '2026-06-01', 999);

    expect(await getAccountAnalytics(ownerA, ACCOUNT_B, RANGE)).toHaveLength(0);
    expect(await getAccountAnalytics(ownerB, ACCOUNT_B, RANGE)).toHaveLength(1);
  });

  it('windows by the range it was given', async () => {
    await seedSnapshot(ORG_A, ACCOUNT_A1, '2026-06-01', 10);
    await seedSnapshot(ORG_A, ACCOUNT_A1, '2026-01-01', 99);

    expect(await getAccountAnalytics(ownerA, ACCOUNT_A1, RANGE)).toHaveLength(1);
  });
});
