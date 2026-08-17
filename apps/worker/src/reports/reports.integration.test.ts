import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, setClock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { renderReport } from './render.js';
import { systemContext } from '@orbit/auth';
import type * as OrbitStorageModule from '@orbit/storage';

type OrbitStorage = typeof OrbitStorageModule;

/**
 * Rendering a report (T3.5).
 *
 * `putObject` is stubbed so nothing here needs S3 — what matters is the *bytes*
 * the renderer produces and the state it leaves the row in, both of which are
 * observable without a bucket.
 *
 * The case that matters most is the one nobody thinks of as a security bug: a
 * CSV cell beginning `=` is executed as a formula when the file is opened, so a
 * post body is untrusted input that ends up in a client's spreadsheet.
 */

const ORG = '018f0a00-0000-7000-8000-000a00000001';
const WS = '018f0a00-0000-7000-8000-000a00000002';
const BRAND = '018f0a00-0000-7000-8000-000a00000003';
const ACCOUNT = '018f0a00-0000-7000-8000-000a00000004';

const NOW = new Date('2026-06-15T12:00:00.000Z');
let restoreClock: (() => void) | undefined;

const written: Array<{ key: string; body: string }> = [];

vi.mock('@orbit/storage', async (importOriginal) => {
  const actual = await importOriginal<OrbitStorage>();
  return {
    ...actual,
    putObject: vi.fn(async (input: { key: string; body: string | Uint8Array }) => {
      const body =
        typeof input.body === 'string' ? input.body : new TextDecoder().decode(input.body);
      written.push({ key: input.key, body });
      return { sizeBytes: body.length };
    }),
  };
});

function ctx() {
  return systemContext({
    organizationId: ORG,
    actorName: 'report-worker',
    capabilities: ['post:read', 'analytics:read'],
    correlationId: 'itest-report',
  });
}

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';

  await platformDb.organization.upsert({
    where: { id: ORG },
    update: {},
    create: { id: ORG, name: 'rep', slug: 'rep-w', timezone: 'UTC' },
  });
  await platformDb.workspace.upsert({
    where: { id: WS },
    update: {},
    create: { id: WS, organizationId: ORG, name: 'ws', slug: 'ws-rep', timezone: 'UTC' },
  });
  await platformDb.brand.upsert({
    where: { id: BRAND },
    update: {},
    create: { id: BRAND, organizationId: ORG, workspaceId: WS, name: 'b', slug: 'b-rep' },
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
      externalId: 'ext-rep-1',
      displayName: 'Client Page',
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });
});

afterAll(async () => {
  restoreClock?.();
  await platformDb.organization.deleteMany({ where: { id: ORG } });
});

beforeEach(async () => {
  restoreClock?.();
  restoreClock = setClock(fixedClock(NOW));
  written.length = 0;

  await platformDb.report.deleteMany({ where: { organizationId: ORG } });
  await platformDb.postAnalytics.deleteMany({ where: { organizationId: ORG } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: ORG } });
  await platformDb.post.deleteMany({ where: { organizationId: ORG } });
});

async function seedPost(body: string, metrics: Record<string, number>, availability = {}) {
  const post = await platformDb.post.create({
    data: {
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      body,
      status: 'PUBLISHED',
      publishedAt: new Date('2026-05-15T09:00:00.000Z'),
    },
  });

  const variant = await platformDb.postVariant.create({
    data: {
      organizationId: ORG,
      postId: post.id,
      socialAccountId: ACCOUNT,
      platform: 'FACEBOOK',
      body,
      status: 'PUBLISHED',
      externalPostId: `ext-${post.id.slice(-6)}`,
      publishedAt: new Date('2026-05-15T09:00:00.000Z'),
    },
  });

  await platformDb.postAnalytics.create({
    data: {
      organizationId: ORG,
      postVariantId: variant.id,
      capturedAt: NOW,
      metrics,
      availability,
      providerApiVersion: 'v25.0',
    },
  });
}

async function queueReport(parameters: Record<string, unknown> = {}) {
  return platformDb.report.create({
    data: {
      organizationId: ORG,
      status: 'QUEUED',
      format: 'CSV',
      parameters: { from: '2026-05-01', to: '2026-05-31', ...parameters },
      expiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1_000),
    },
  });
}

describe('rendering', () => {
  it('writes a CSV and marks the report READY with a key and a size', async () => {
    await seedPost('A published post', { post_media_view: 120 });
    const report = await queueReport();

    const result = await renderReport({ ctx: ctx(), reportId: report.id, correlationId: 'c' });

    expect(result).toMatchObject({ kind: 'RENDERED', rows: 1 });

    const after = await platformDb.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(after.status).toBe('READY');
    expect(after.storageKey).toContain(`org/${ORG}/`);
    expect(after.sizeBytes).toBeGreaterThan(0);
  });

  it('includes the figures under a column named for the metric', async () => {
    await seedPost('A published post', { post_media_view: 120 });
    const report = await queueReport();

    await renderReport({ ctx: ctx(), reportId: report.id, correlationId: 'c' });

    const csv = written[0]?.body ?? '';
    expect(csv).toContain('post_media_view');
    expect(csv).toContain('120');
  });

  /**
   * D-057, carried into the file. An empty cell is totalled as zero by every
   * spreadsheet there is, which would turn "Facebook stopped reporting this"
   * into "nobody engaged" the moment a client opens it.
   */
  it('writes the reason for an unavailable metric, never an empty cell', async () => {
    await seedPost('A published post', {}, { post_impressions: 'DEPRECATED' });
    const report = await queueReport();

    await renderReport({ ctx: ctx(), reportId: report.id, correlationId: 'c' });

    const csv = written[0]?.body ?? '';
    expect(csv).toContain('post_impressions');
    expect(csv).toContain('not provided by platform');
  });

  /**
   * A post body is untrusted input, and a CSV cell starting with `=` runs as a
   * formula in Excel and Sheets. This is the one bug in a reporting feature
   * that executes code on a client's machine.
   */
  it('neutralises a cell that a spreadsheet would run as a formula', async () => {
    await seedPost('=HYPERLINK("http://evil.test","click")', { post_media_view: 1 });
    const report = await queueReport();

    await renderReport({ ctx: ctx(), reportId: report.id, correlationId: 'c' });

    const csv = written[0]?.body ?? '';
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/,"=HYPERLINK/);
  });

  it('escapes quotes rather than breaking the row', async () => {
    await seedPost('He said "hello"', { post_media_view: 1 });
    const report = await queueReport();

    await renderReport({ ctx: ctx(), reportId: report.id, correlationId: 'c' });

    expect(written[0]?.body ?? '').toContain('He said ""hello""');
  });

  it('covers the closing day of the range', async () => {
    // Published on the last day named in the range.
    const post = await platformDb.post.create({
      data: {
        organizationId: ORG,
        workspaceId: WS,
        brandId: BRAND,
        body: 'Last day',
        status: 'PUBLISHED',
        publishedAt: new Date('2026-05-31T23:30:00.000Z'),
      },
    });
    await platformDb.postVariant.create({
      data: {
        organizationId: ORG,
        postId: post.id,
        socialAccountId: ACCOUNT,
        platform: 'FACEBOOK',
        body: 'Last day',
        status: 'PUBLISHED',
        externalPostId: 'ext-last',
        publishedAt: new Date('2026-05-31T23:30:00.000Z'),
      },
    });

    const report = await queueReport();
    const result = await renderReport({ ctx: ctx(), reportId: report.id, correlationId: 'c' });

    expect(result).toMatchObject({ kind: 'RENDERED', rows: 1 });
  });

  /**
   * A retry after success must not overwrite a good file with a second copy,
   * and must not resurrect a report somebody already saw fail.
   */
  it('skips a report that has already settled', async () => {
    const report = await queueReport();
    await platformDb.report.update({ where: { id: report.id }, data: { status: 'READY' } });

    const result = await renderReport({ ctx: ctx(), reportId: report.id, correlationId: 'c' });

    expect(result).toEqual({ kind: 'SKIPPED', reason: 'ALREADY_SETTLED' });
    expect(written).toHaveLength(0);
  });

  it('renders an empty range without failing', async () => {
    const report = await queueReport({ from: '2020-01-01', to: '2020-01-31' });

    const result = await renderReport({ ctx: ctx(), reportId: report.id, correlationId: 'c' });

    expect(result).toMatchObject({ kind: 'RENDERED', rows: 0 });
    expect((await platformDb.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe(
      'READY',
    );
  });
});
