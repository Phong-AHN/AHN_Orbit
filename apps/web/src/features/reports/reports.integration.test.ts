import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  NotFoundError,
  ValidationError,
  fixedClock,
  setClock,
  type TenantContext,
} from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection, redis } from '@orbit/queue';
import { createReport, getReport, getReportDownloadUrl, listReports } from './service';

/**
 * Reports against the real database (T3.5).
 *
 * The cases worth having are the security ones, because a report is a file of
 * one client's data and every mistake here hands it to somebody:
 *
 * - the storage key must never appear in anything a route can serialise;
 * - another tenant's report must be invisible by exact id;
 * - an expired report must be refused even though its row still exists;
 * - a report must not be able to name a workspace it cannot see.
 */

const ORG_A = '018ffe00-0000-7000-8000-0000fe000001';
const ORG_B = '018fff00-0000-7000-8000-0000ff000001';
const WS_A = '018ffe00-0000-7000-8000-0000fe000002';
const WS_B = '018fff00-0000-7000-8000-0000ff000002';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ctxA: TenantContext;
let ctxB: TenantContext;
let restoreClock: (() => void) | undefined;

async function seed(org: string, ws: string, slug: string, email: string) {
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

  const identity = await devIdentityProvider.verifyIdToken(`dev:${email}`);
  const user = await resolveUser(identity);

  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId: user.id } },
    update: {},
    create: { organizationId: org, userId: user.id, role: 'OWNER', status: 'ACTIVE' },
  });

  const { ctx } = await resolveTenantContext(user, org, 'itest-reports');
  return ctx;
}

async function flushRedis() {
  const connection = redis();
  let cursor = '0';
  do {
    const [next, keys] = await connection.scan(cursor, 'MATCH', 'bull:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await connection.del(...keys);
  } while (cursor !== '0');
}

beforeAll(async () => {
  ctxA = await seed(ORG_A, WS_A, 'rep-a', 'owner@rep-a.test');
  ctxB = await seed(ORG_B, WS_B, 'rep-b', 'owner@rep-b.test');
});

afterAll(async () => {
  restoreClock?.();
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '.test' } } });
  await closeQueues();
  await closeSharedConnection();
});

beforeEach(async () => {
  restoreClock?.();
  restoreClock = setClock(fixedClock(NOW));

  await flushRedis();
  await platformDb.report.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

const params = { from: '2026-05-01', to: '2026-05-31', format: 'CSV' as const };

describe('requesting a report', () => {
  it('starts QUEUED with the range it was asked for', async () => {
    const report = await createReport(ctxA, params, 'corr-1', fingerprint);

    expect(report.status).toBe('QUEUED');
    expect(report.parameters).toMatchObject({ from: '2026-05-01', to: '2026-05-31' });
  });

  /**
   * The whole security model of the download route rests on this. A key that
   * never enters the object cannot be leaked by a route that serialises
   * everything it is handed.
   */
  it('never returns the storage key, on create or on read or on list', async () => {
    const created = await createReport(ctxA, params, 'corr-1', fingerprint);

    // Put a key on the row, as the renderer would.
    await platformDb.report.update({
      where: { id: created.id },
      data: { status: 'READY', storageKey: `org/${ORG_A}/secret/path.csv`, sizeBytes: 10 },
    });

    const fetched = await getReport(ctxA, created.id);
    const [listed] = await listReports(ctxA);

    for (const shape of [created, fetched, listed]) {
      expect(JSON.stringify(shape)).not.toContain('secret/path');
      expect(shape).not.toHaveProperty('storageKey');
    }
  });

  it('records who asked, from the session rather than the input', async () => {
    const created = await createReport(ctxA, params, 'corr-1', fingerprint);

    expect(created.requestedBy?.email).toBe('owner@rep-a.test');
  });

  it('writes an audit row', async () => {
    await createReport(ctxA, params, 'corr-1', fingerprint);

    expect(
      await platformDb.auditLog.findFirst({
        where: { organizationId: ORG_A, action: 'report.requested' },
      }),
    ).not.toBeNull();
  });

  it('refuses a workspace from another tenant, by exact id', async () => {
    await expect(
      createReport(ctxA, { ...params, workspaceId: WS_B }, 'corr-1', fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('sets an expiry rather than leaving the file reachable forever', async () => {
    const created = await createReport(ctxA, params, 'corr-1', fingerprint);

    expect(created.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe('cross-tenant isolation', () => {
  it('does not find another tenant report by exact id', async () => {
    const theirs = await createReport(ctxB, params, 'corr-1', fingerprint);

    await expect(getReport(ctxA, theirs.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('never lists another tenant reports', async () => {
    await createReport(ctxB, params, 'corr-1', fingerprint);

    expect(await listReports(ctxA)).toHaveLength(0);
    expect(await listReports(ctxB)).toHaveLength(1);
  });

  it('refuses to sign a download for another tenant report', async () => {
    const theirs = await createReport(ctxB, params, 'corr-1', fingerprint);
    await platformDb.report.update({
      where: { id: theirs.id },
      data: { status: 'READY', storageKey: `org/${ORG_B}/x.csv` },
    });

    await expect(getReportDownloadUrl(ctxA, theirs.id, fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('downloading', () => {
  async function ready(
    ctx: TenantContext,
    org: string,
    expiresAt = new Date(NOW.getTime() + 1000),
  ) {
    const created = await createReport(ctx, params, 'corr-1', fingerprint);
    await platformDb.report.update({
      where: { id: created.id },
      data: {
        status: 'READY',
        storageKey: `org/${org}/2026/06/${created.id}/report.csv`,
        expiresAt,
      },
    });
    return created.id;
  }

  it('refuses a report that is still rendering', async () => {
    const created = await createReport(ctxA, params, 'corr-1', fingerprint);

    await expect(getReportDownloadUrl(ctxA, created.id, fingerprint)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  /**
   * The row and the object may both outlive the expiry — a sweep has not been
   * written yet. Enforcing it on read is what makes the expiry mean anything
   * rather than being a decorative timestamp.
   */
  it('refuses an expired report even though the row still exists', async () => {
    const id = await ready(ctxA, ORG_A, new Date(NOW.getTime() - 1_000));

    await expect(getReportDownloadUrl(ctxA, id, fingerprint)).rejects.toBeInstanceOf(NotFoundError);
    expect(await platformDb.report.findUnique({ where: { id } })).not.toBeNull();
  });

  it('audits the download, because a report leaving is a thing to have recorded', async () => {
    const id = await ready(ctxA, ORG_A);

    await getReportDownloadUrl(ctxA, id, fingerprint);

    expect(
      await platformDb.auditLog.findFirst({
        where: { organizationId: ORG_A, action: 'report.downloaded', resourceId: id },
      }),
    ).not.toBeNull();
  });

  /**
   * The last line of defence. Even if every check above were somehow bypassed,
   * a key outside this tenant's prefix is not signed.
   */
  it('refuses to sign a key that does not carry this tenant prefix', async () => {
    const created = await createReport(ctxA, params, 'corr-1', fingerprint);
    await platformDb.report.update({
      where: { id: created.id },
      data: { status: 'READY', storageKey: `org/${ORG_B}/smuggled.csv` },
    });

    await expect(getReportDownloadUrl(ctxA, created.id, fingerprint)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
