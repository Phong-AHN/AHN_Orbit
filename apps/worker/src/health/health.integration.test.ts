import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantIsolationError, fixedClock, setClock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection, queueFor, redis } from '@orbit/queue';
import { CredentialCipher, registerProvider, resetRegistry } from '@orbit/providers';
import { MockProvider } from '@orbit/providers/mock';
import { processAccountHealth } from '../processors/account-health.js';
import { sweepAccountHealth } from './sweep.js';

/**
 * Account health against real Postgres, real Redis and the mock provider (T1.7).
 *
 * The properties worth proving here are the ones a unit test cannot reach: that
 * a verdict, its audit row and its notifications commit together; that an
 * account left broken does not re-notify every hour; that the sweep respects the
 * debounce; and that a payload naming the wrong tenant fails closed.
 */

const ORG = '018ff700-0000-7000-8000-0000f7000001';
const ORG_B = '018ff800-0000-7000-8000-0000f8000001';
const WS = '018ff700-0000-7000-8000-0000f7000002';
const BRAND = '018ff700-0000-7000-8000-0000f7000003';
const ACCOUNT = '018ff700-0000-7000-8000-0000f7000004';
const ACCOUNT_2 = '018ff700-0000-7000-8000-0000f7000005';
const OWNER = '018ff700-0000-7000-8000-0000f7000006';
const MANAGER = '018ff700-0000-7000-8000-0000f7000007';
const OUTSIDER = '018ff700-0000-7000-8000-0000f7000008';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1_000;

let mock: MockProvider;
let restoreClock: (() => void) | undefined;

function jobFor(accountId = ACCOUNT, claimedOrg = ORG) {
  return {
    payload: {
      organizationId: claimedOrg,
      correlationId: 'itest-health',
      socialAccountId: accountId,
    },
    attempt: 1,
    jobId: 'queue-job-health-1',
    correlationId: 'itest-health',
  };
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

async function seedAccount(id: string, externalId: string, scopes = ['mock_publish']) {
  await platformDb.socialAccount.upsert({
    where: { id },
    update: { status: 'ACTIVE', healthError: null, healthCheckedAt: null },
    create: {
      id,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      platform: 'FACEBOOK',
      externalId,
      displayName: `Page ${externalId}`,
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });

  const cipher = new CredentialCipher();
  const sealed = cipher.seal('mock-access-token', {
    organizationId: ORG,
    socialAccountId: id,
  });

  await platformDb.socialCredential.upsert({
    where: { socialAccountId: id },
    update: { scopes },
    create: {
      organizationId: ORG,
      socialAccountId: id,
      accessTokenCiphertext: new Uint8Array(sealed.ciphertext),
      accessTokenIv: new Uint8Array(sealed.iv),
      accessTokenAuthTag: new Uint8Array(sealed.authTag),
      keyVersion: sealed.keyVersion,
      scopes,
    },
  });
}

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';

  for (const [id, slug] of [
    [ORG, 't7'],
    [ORG_B, 't7b'],
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

  // Three people: an Owner (org-wide reconnect right), an Account Manager
  // (workspace-scoped) and a Content Creator (no right at all). Who gets told
  // is derived from the grant matrix, so all three are worth seeding.
  const people = [
    [OWNER, 'owner', 'OWNER'],
    [MANAGER, 'manager', 'ACCOUNT_MANAGER'],
    [OUTSIDER, 'creator', 'CONTENT_CREATOR'],
  ] as const;

  for (const [id, name, role] of people) {
    await platformDb.user.upsert({
      where: { id },
      update: {},
      create: { id, firebaseUid: `dev:${name}@t7.test`, email: `${name}@t7.test` },
    });
    await platformDb.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: ORG, userId: id } },
      update: { role, status: 'ACTIVE' },
      create: { organizationId: ORG, userId: id, role, status: 'ACTIVE' },
    });
  }

  // The manager runs this workspace; the creator does not.
  await platformDb.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId: WS, userId: MANAGER } },
    update: {},
    create: { organizationId: ORG, workspaceId: WS, userId: MANAGER, role: 'MANAGER' },
  });
});

beforeEach(async () => {
  restoreClock = setClock(fixedClock(NOW));

  resetRegistry();
  mock = new MockProvider();
  registerProvider(mock, { developmentOnly: true });

  await platformDb.notification.deleteMany({ where: { organizationId: ORG } });
  await platformDb.auditLog.deleteMany({ where: { organizationId: ORG } });
  await platformDb.socialCredential.deleteMany({ where: { organizationId: ORG } });
  await platformDb.socialAccount.deleteMany({ where: { organizationId: ORG } });
  await flushRedis();

  await seedAccount(ACCOUNT, 'page-one');
});

afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
});

afterAll(async () => {
  await flushRedis();
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { id: { in: [OWNER, MANAGER, OUTSIDER] } } });
  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

// ── The probe ───────────────────────────────────────────────────────────────

describe('probing an account', () => {
  it('records a healthy verdict', async () => {
    await processAccountHealth(jobFor());

    const account = await platformDb.socialAccount.findUniqueOrThrow({ where: { id: ACCOUNT } });
    expect(account.status).toBe('ACTIVE');
    expect(account.healthCheckedAt).toEqual(NOW);
    expect(account.healthError).toBeNull();
    expect(mock.callCounts.health).toBe(1);
  });

  it('does not notify anyone about an account that was fine and stayed fine', async () => {
    // The hourly sweep hits this case for almost every account, almost always.
    await processAccountHealth(jobFor());

    expect(await platformDb.notification.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await platformDb.auditLog.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('demotes an account the provider says is broken, and tells the right people', async () => {
    mock.fault = 'AUTH_EXPIRED';

    await processAccountHealth(jobFor());

    const account = await platformDb.socialAccount.findUniqueOrThrow({ where: { id: ACCOUNT } });
    expect(account.status).toBe('NEEDS_RECONNECT');
    expect(account.healthError).toBe('The mock account needs to be reconnected.');

    const notified = await platformDb.notification.findMany({
      where: { organizationId: ORG },
      select: { userId: true, type: true, resourceId: true },
    });

    // The Owner (org-wide) and the Account Manager (this workspace) can fix it.
    // The Content Creator cannot, and is not told.
    expect(notified.map((n) => n.userId).sort()).toEqual([OWNER, MANAGER].sort());
    expect(notified.every((n) => n.type === 'social_account.needs_reconnect')).toBe(true);
    expect(notified.every((n) => n.resourceId === ACCOUNT)).toBe(true);

    const audits = await platformDb.auditLog.findMany({ where: { organizationId: ORG } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('social_account.health_degraded');
    expect(audits[0]?.actorType).toBe('WORKER');
  });

  it('does not notify twice about an account that is still broken', async () => {
    // Without the transition guard, an account left broken over a weekend would
    // generate a notification every hour — and people learn to ignore those.
    mock.fault = 'AUTH_EXPIRED';
    await processAccountHealth(jobFor());

    const first = await platformDb.notification.count({ where: { organizationId: ORG } });

    // An hour later, still broken.
    restoreClock?.();
    restoreClock = setClock(fixedClock(new Date(NOW.getTime() + HOUR)));
    mock.fault = 'AUTH_EXPIRED';
    await processAccountHealth(jobFor());

    expect(await platformDb.notification.count({ where: { organizationId: ORG } })).toBe(first);
    expect(await platformDb.auditLog.count({ where: { organizationId: ORG } })).toBe(1);
  });

  it('restores an account when a later probe succeeds, and clears the error', async () => {
    mock.fault = 'AUTH_EXPIRED';
    await processAccountHealth(jobFor());

    restoreClock?.();
    restoreClock = setClock(fixedClock(new Date(NOW.getTime() + HOUR)));
    await processAccountHealth(jobFor());

    const account = await platformDb.socialAccount.findUniqueOrThrow({ where: { id: ACCOUNT } });
    expect(account.status).toBe('ACTIVE');
    expect(account.healthError).toBeNull();

    const recovery = await platformDb.notification.findMany({
      where: { organizationId: ORG, type: 'social_account.reconnected' },
    });
    expect(recovery).toHaveLength(2); // owner + manager

    const audits = await platformDb.auditLog.findMany({
      where: { organizationId: ORG, action: 'social_account.health_recovered' },
    });
    expect(audits).toHaveLength(1);
  });

  it('reports a missing scope as needing reconnection', async () => {
    // The mock treats an absent `mock_publish` scope the way a real adapter
    // treats a withdrawn permission: the token lives, but it is not enough.
    await seedAccount(ACCOUNT_2, 'page-two', ['mock_read']);

    await processAccountHealth(jobFor(ACCOUNT_2));

    const account = await platformDb.socialAccount.findUniqueOrThrow({ where: { id: ACCOUNT_2 } });
    expect(account.status).toBe('NEEDS_RECONNECT');
    expect(account.healthError).toBe('A required permission is missing.');
  });

  it('does not probe an account checked recently', async () => {
    await processAccountHealth(jobFor());
    expect(mock.callCounts.health).toBe(1);

    // Same instant, so the debounce applies. A second call spends nothing.
    await processAccountHealth(jobFor());
    expect(mock.callCounts.health).toBe(1);
  });

  it('does not probe an account nobody has connected', async () => {
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT },
      data: { status: 'DISABLED' },
    });

    await processAccountHealth(jobFor());

    expect(mock.callCounts.health).toBe(0);
  });
});

// ── Tenant isolation (decision D-021) ───────────────────────────────────────

describe('tenant derivation', () => {
  it('refuses a payload that names a different tenant than the account', async () => {
    await expect(processAccountHealth(jobFor(ACCOUNT, ORG_B))).rejects.toThrow(
      TenantIsolationError,
    );

    // Nothing was probed and nothing was written.
    expect(mock.callCounts.health).toBe(0);
    const account = await platformDb.socialAccount.findUniqueOrThrow({ where: { id: ACCOUNT } });
    expect(account.healthCheckedAt).toBeNull();
  });

  it('refuses a payload naming an account that does not exist', async () => {
    await expect(
      processAccountHealth(jobFor('018ff700-0000-7000-8000-0000f700ffff')),
    ).rejects.toThrow(TenantIsolationError);
  });
});

// ── The sweep ───────────────────────────────────────────────────────────────

describe('the health sweep', () => {
  /**
   * The sweep is platform-wide by design, so its counters include accounts
   * belonging to other test files' tenants. Asserting on what it queued *for
   * this account* is both the precise question and the stable one.
   */
  async function queuedFor(accountId: string): Promise<number> {
    const jobs = await queueFor('account-health').getJobs(['waiting', 'delayed', 'prioritized']);
    return jobs.filter(
      (job) => (job.data as { socialAccountId?: string }).socialAccountId === accountId,
    ).length;
  }

  it('queues a probe for an account that has never been checked', async () => {
    const result = await sweepAccountHealth('itest-sweep');

    expect(result.failed).toBe(0);
    expect(await queuedFor(ACCOUNT)).toBe(1);
  });

  it('does not queue an account checked within the interval', async () => {
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT },
      data: { healthCheckedAt: new Date(NOW.getTime() - 5 * 60_000) },
    });

    await sweepAccountHealth('itest-sweep');

    expect(await queuedFor(ACCOUNT)).toBe(0);
  });

  it('queues an account once the interval has elapsed', async () => {
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT },
      data: { healthCheckedAt: new Date(NOW.getTime() - HOUR - 1_000) },
    });

    await sweepAccountHealth('itest-sweep');

    expect(await queuedFor(ACCOUNT)).toBe(1);
  });

  it('keeps re-probing a broken account, because that is how recovery is noticed', async () => {
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT },
      data: { status: 'NEEDS_RECONNECT', healthCheckedAt: new Date(NOW.getTime() - 2 * HOUR) },
    });

    await sweepAccountHealth('itest-sweep');

    expect(await queuedFor(ACCOUNT)).toBe(1);
  });

  it('leaves disconnected accounts alone', async () => {
    // A person put these into that state; probing would spend quota to confirm
    // something we already know.
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT },
      data: { status: 'REVOKED' },
    });

    await sweepAccountHealth('itest-sweep');

    expect(await queuedFor(ACCOUNT)).toBe(0);
  });

  it('sweeping twice queues one probe', async () => {
    // Several worker instances sweep in parallel by design; the deterministic
    // job id per interval collapses the duplicate.
    await sweepAccountHealth('itest-sweep');
    await sweepAccountHealth('itest-sweep');

    expect(await queuedFor(ACCOUNT)).toBe(1);
  });
});
