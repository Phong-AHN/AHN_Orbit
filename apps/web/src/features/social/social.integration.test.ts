import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  NotFoundError,
  ProviderAuthenticationError,
  ProviderUnavailableError,
  type TenantContext,
} from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { registerProvider, resetRegistry } from '@orbit/providers';
import { MockProvider } from '@orbit/providers/mock';
import {
  checkAccountHealth,
  connectAccounts,
  disconnectAccount,
  discardStagedAccounts,
  getAccount,
  listAccounts,
  listAccountsNeedingReconnection,
  loadCredential,
  stageDiscoveredAccounts,
  startReconnect,
} from './service';

/**
 * The connection lifecycle, end to end against the database.
 *
 * Uses the mock provider, so nothing here needs Meta credentials. What it does
 * exercise for real: credential sealing and unsealing, staging, activation,
 * discard, health recording, disconnection, tenant isolation, and audit.
 */

const ORG_A = '018f4a00-0000-7000-8000-00004a1f0001';
const ORG_B = '018f4b00-0000-7000-8000-00004b1f0001';
const WS_A = '018f4a00-0000-7000-8000-00004a1f0002';
const BRAND_A = '018f4a00-0000-7000-8000-00004a1f0003';
const WS_B = '018f4b00-0000-7000-8000-00004b1f0002';
const BRAND_B = '018f4b00-0000-7000-8000-00004b1f0003';
const USER_A = '018f4a00-0000-7000-8000-00004a1f0004';
const USER_B = '018f4b00-0000-7000-8000-00004b1f0004';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ctxA: TenantContext;
let ctxB: TenantContext;
let mock: MockProvider;

const discovered = (externalId: string, token = 'page-token') => ({
  externalId,
  displayName: `Page ${externalId}`,
  handle: `page${externalId}`,
  accountType: 'PAGE',
  credential: { accessToken: token, scopes: ['mock_read', 'mock_publish'] as const },
});

async function seedTenant(org: string, ws: string, brand: string, user: string, slug: string) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: slug, slug, timezone: 'UTC' },
  });
  await platformDb.user.upsert({
    where: { id: user },
    update: {},
    create: { id: user, firebaseUid: `dev:${slug}@t6.test`, email: `${slug}@t6.test` },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId: user } },
    update: { role: 'OWNER', status: 'ACTIVE' },
    create: { organizationId: org, userId: user, role: 'OWNER', status: 'ACTIVE' },
  });
  await platformDb.workspace.upsert({
    where: { id: ws },
    update: {},
    create: { id: ws, organizationId: org, name: 'ws', slug: 'main', timezone: 'UTC' },
  });
  await platformDb.brand.upsert({
    where: { id: brand },
    update: {},
    create: { id: brand, organizationId: org, workspaceId: ws, name: 'brand', slug: 'brand' },
  });
}

async function contextFor(email: string, orgId: string): Promise<TenantContext> {
  const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${email}`));
  return (await resolveTenantContext(user, orgId)).ctx;
}

beforeAll(async () => {
  await seedTenant(ORG_A, WS_A, BRAND_A, USER_A, 't6a');
  await seedTenant(ORG_B, WS_B, BRAND_B, USER_B, 't6b');
  ctxA = await contextFor('t6a@t6.test', ORG_A);
  ctxB = await contextFor('t6b@t6.test', ORG_B);
});

beforeEach(async () => {
  resetRegistry();
  mock = new MockProvider();
  registerProvider(mock, { developmentOnly: true });

  await platformDb.notification.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  });
  await platformDb.auditLog.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  });
  await platformDb.socialCredential.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  });
  await platformDb.socialAccount.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  });
});

afterAll(async () => {
  resetRegistry();
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { id: { in: [USER_A, USER_B] } } });
  await platformDb.$disconnect();
});

describe('staging discovered accounts', () => {
  it('stores every discovered account as DISABLED with a sealed credential', async () => {
    const staged = await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1'), discovered('page-2')],
    });

    expect(staged).toHaveLength(2);

    const rows = await platformDb.socialAccount.findMany({ where: { organizationId: ORG_A } });
    expect(rows.every((r) => r.status === 'DISABLED')).toBe(true);

    const credentials = await platformDb.socialCredential.findMany({
      where: { organizationId: ORG_A },
    });
    expect(credentials).toHaveLength(2);
    // Encrypted at rest from the moment it exists.
    expect(Buffer.from(credentials[0]!.accessTokenCiphertext).toString('utf8')).not.toContain(
      'page-token',
    );
  });

  it('refuses a brand from another tenant, by exact id', async () => {
    await expect(
      stageDiscoveredAccounts(ctxA, {
        platform: 'FACEBOOK',
        workspaceId: WS_B,
        brandId: BRAND_B,
        discovered: [discovered('page-x')],
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('does not disturb an account that is already live', async () => {
    await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1')],
    });
    const [staged] = await platformDb.socialAccount.findMany({ where: { organizationId: ORG_A } });
    await connectAccounts(
      ctxA,
      {
        platform: 'FACEBOOK',
        workspaceId: WS_A,
        brandId: BRAND_A,
        socialAccountIds: [staged!.id],
      },
      fingerprint,
    );

    // Re-authorizing later must not knock a live account back to DISABLED.
    const again = await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1', 'rotated-token')],
    });

    expect(again[0]!.alreadyConnected).toBe(true);
    const row = await platformDb.socialAccount.findUniqueOrThrow({ where: { id: staged!.id } });
    expect(row.status).toBe('ACTIVE');
  });
});

describe('connecting', () => {
  async function stageTwo() {
    await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1'), discovered('page-2')],
    });
    return platformDb.socialAccount.findMany({
      where: { organizationId: ORG_A },
      orderBy: { externalId: 'asc' },
    });
  }

  it('activates the chosen accounts and discards the rest', async () => {
    const staged = await stageTwo();

    const connected = await connectAccounts(
      ctxA,
      {
        platform: 'FACEBOOK',
        workspaceId: WS_A,
        brandId: BRAND_A,
        socialAccountIds: [staged[0]!.id],
      },
      fingerprint,
    );

    expect(connected).toHaveLength(1);
    expect(connected[0]!.reconnected).toBe(false);

    const remaining = await platformDb.socialAccount.findMany({ where: { organizationId: ORG_A } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.status).toBe('ACTIVE');

    // The unchosen account's credential is gone, not merely orphaned.
    const credentials = await platformDb.socialCredential.findMany({
      where: { organizationId: ORG_A },
    });
    expect(credentials).toHaveLength(1);
  });

  it('marks a previously-connected account as reconnected, not duplicated', async () => {
    const staged = await stageTwo();
    await connectAccounts(
      ctxA,
      {
        platform: 'FACEBOOK',
        workspaceId: WS_A,
        brandId: BRAND_A,
        socialAccountIds: [staged[0]!.id],
      },
      fingerprint,
    );

    await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1', 'fresh-token')],
    });

    const result = await connectAccounts(
      ctxA,
      {
        platform: 'FACEBOOK',
        workspaceId: WS_A,
        brandId: BRAND_A,
        socialAccountIds: [staged[0]!.id],
      },
      fingerprint,
    );

    expect(result[0]!.reconnected).toBe(true);
    expect(await platformDb.socialAccount.count({ where: { organizationId: ORG_A } })).toBe(1);

    // The rotated credential replaced the old one.
    const credential = await loadCredential(ctxA, staged[0]!.id);
    expect(credential.accessToken).toBe('fresh-token');
  });

  it('refuses an account id from another tenant', async () => {
    await stageDiscoveredAccounts(ctxB, {
      platform: 'FACEBOOK',
      workspaceId: WS_B,
      brandId: BRAND_B,
      discovered: [discovered('page-b')],
    });
    const [foreign] = await platformDb.socialAccount.findMany({ where: { organizationId: ORG_B } });

    await expect(
      connectAccounts(
        ctxA,
        {
          platform: 'FACEBOOK',
          workspaceId: WS_A,
          brandId: BRAND_A,
          socialAccountIds: [foreign!.id],
        },
        fingerprint,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('writes an audit entry that contains no token', async () => {
    const staged = await stageTwo();
    await connectAccounts(
      ctxA,
      {
        platform: 'FACEBOOK',
        workspaceId: WS_A,
        brandId: BRAND_A,
        socialAccountIds: [staged[0]!.id],
      },
      fingerprint,
    );

    const entry = await platformDb.auditLog.findFirstOrThrow({
      where: { organizationId: ORG_A, action: 'social_account.connected' },
    });

    expect(JSON.stringify(entry.after)).not.toContain('page-token');
    expect(entry.actorUserId).toBe(USER_A);
  });
});

describe('credential storage', () => {
  it('round-trips a sealed credential', async () => {
    await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1', 'the-secret-token')],
    });
    const [row] = await platformDb.socialAccount.findMany({ where: { organizationId: ORG_A } });

    const credential = await loadCredential(ctxA, row!.id);
    expect(credential.accessToken).toBe('the-secret-token');
    expect(credential.scopes).toContain('mock_publish');
  });

  it('never returns credential material through the account API', async () => {
    await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1', 'the-secret-token')],
    });
    const [row] = await platformDb.socialAccount.findMany({ where: { organizationId: ORG_A } });

    const account = await getAccount(ctxA, row!.id);
    expect(JSON.stringify(account)).not.toContain('the-secret-token');
    expect(account).not.toHaveProperty('credential');
  });

  it('cannot decrypt a credential under another tenant’s context', async () => {
    await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1')],
    });
    const [row] = await platformDb.socialAccount.findMany({ where: { organizationId: ORG_A } });

    // Scoped lookup finds nothing; the AAD binding would refuse it even if it did.
    await expect(loadCredential(ctxB, row!.id)).rejects.toThrow(NotFoundError);
  });
});

describe('health', () => {
  async function connectOne() {
    await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1')],
    });
    const [row] = await platformDb.socialAccount.findMany({ where: { organizationId: ORG_A } });
    await connectAccounts(
      ctxA,
      { platform: 'FACEBOOK', workspaceId: WS_A, brandId: BRAND_A, socialAccountIds: [row!.id] },
      fingerprint,
    );
    return row!.id;
  }

  it('records an ACTIVE probe', async () => {
    const id = await connectOne();
    const health = await checkAccountHealth(ctxA, id);

    expect(health.status).toBe('ACTIVE');
    const row = await platformDb.socialAccount.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.healthCheckedAt).not.toBeNull();
  });

  it('records NEEDS_RECONNECT and the reason when the provider says so', async () => {
    const id = await connectOne();
    mock.fault = 'AUTH_EXPIRED';

    const health = await checkAccountHealth(ctxA, id);
    expect(health.status).toBe('NEEDS_RECONNECT');

    const row = await platformDb.socialAccount.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('NEEDS_RECONNECT');
    expect(row.healthError).toBeTruthy();
  });

  it('does not find an account from another tenant', async () => {
    const id = await connectOne();
    await expect(checkAccountHealth(ctxB, id)).rejects.toThrow(NotFoundError);
  });

  // ── T1.7 ──────────────────────────────────────────────────────────────────

  it('notifies and audits when an account breaks', async () => {
    const id = await connectOne();
    mock.fault = 'AUTH_EXPIRED';

    await checkAccountHealth(ctxA, id);

    const notifications = await platformDb.notification.findMany({
      where: { organizationId: ORG_A, resourceId: id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.userId).toBe(USER_A);
    expect(notifications[0]?.type).toBe('social_account.needs_reconnect');

    const audits = await platformDb.auditLog.findMany({
      where: { organizationId: ORG_A, action: 'social_account.health_degraded' },
    });
    expect(audits).toHaveLength(1);
    // A person asked for this check, so the row names them rather than a worker.
    expect(audits[0]?.actorUserId).toBe(USER_A);
  });

  it('does not notify when a healthy account stays healthy', async () => {
    const id = await connectOne();

    await checkAccountHealth(ctxA, id);

    expect(await platformDb.notification.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('clears the error and notifies on recovery', async () => {
    const id = await connectOne();
    mock.fault = 'AUTH_EXPIRED';
    await checkAccountHealth(ctxA, id);

    const recovered = await checkAccountHealth(ctxA, id);
    expect(recovered.status).toBe('ACTIVE');

    const row = await platformDb.socialAccount.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.healthError).toBeNull();

    expect(
      await platformDb.notification.count({
        where: { organizationId: ORG_A, type: 'social_account.reconnected' },
      }),
    ).toBe(1);
  });

  it('does not blame the account for a transient provider outage', async () => {
    // A five-minute Meta outage must not send a reconnect prompt to every
    // client. Only an error that means the credential is dead is a verdict.
    const id = await connectOne();
    mock.probeHealth = () => Promise.reject(new ProviderUnavailableError('Mock platform is down'));

    await expect(checkAccountHealth(ctxA, id)).rejects.toThrow(ProviderUnavailableError);

    const row = await platformDb.socialAccount.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ACTIVE');
    expect(await platformDb.notification.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('demotes the account when the probe itself fails authentication', async () => {
    const id = await connectOne();
    mock.probeHealth = () => Promise.reject(new ProviderAuthenticationError('Token revoked'));

    await checkAccountHealth(ctxA, id);

    const row = await platformDb.socialAccount.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('NEEDS_RECONNECT');
    expect(row.healthError).toBeTruthy();
    // The stored text is the safe user message, never the provider's own.
    expect(row.healthError).not.toContain('Token revoked');
  });

  it('honours a debounce when asked to, and ignores it by default', async () => {
    const id = await connectOne();

    await checkAccountHealth(ctxA, id);
    const afterFirst = mock.callCounts.health;

    // The sweep's behaviour: recently checked, so no provider call.
    await checkAccountHealth(ctxA, id, { minIntervalMs: 60 * 60 * 1000 });
    expect(mock.callCounts.health).toBe(afterFirst);

    // A person clicking "check now" gets a real check.
    await checkAccountHealth(ctxA, id);
    expect(mock.callCounts.health).toBe(afterFirst + 1);
  });
});

describe('listing accounts that need reconnection', () => {
  async function connectOne() {
    await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1')],
    });
    const [row] = await platformDb.socialAccount.findMany({ where: { organizationId: ORG_A } });
    await connectAccounts(
      ctxA,
      { platform: 'FACEBOOK', workspaceId: WS_A, brandId: BRAND_A, socialAccountIds: [row!.id] },
      fingerprint,
    );
    return row!.id;
  }

  it('returns nothing while everything is healthy', async () => {
    await connectOne();
    expect(await listAccountsNeedingReconnection(ctxA)).toHaveLength(0);
  });

  it('returns a broken account with the reason the banner shows', async () => {
    const id = await connectOne();
    mock.fault = 'AUTH_EXPIRED';
    await checkAccountHealth(ctxA, id);

    const broken = await listAccountsNeedingReconnection(ctxA);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.id).toBe(id);
    expect(broken[0]?.healthError).toBeTruthy();
  });

  it('does not leak another tenant’s broken accounts', async () => {
    const id = await connectOne();
    mock.fault = 'AUTH_EXPIRED';
    await checkAccountHealth(ctxA, id);

    expect(await listAccountsNeedingReconnection(ctxB)).toHaveLength(0);
  });
});

describe('starting a reconnect', () => {
  async function connectOne() {
    await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1')],
    });
    const [row] = await platformDb.socialAccount.findMany({ where: { organizationId: ORG_A } });
    await connectAccounts(
      ctxA,
      { platform: 'FACEBOOK', workspaceId: WS_A, brandId: BRAND_A, socialAccountIds: [row!.id] },
      fingerprint,
    );
    return row!.id;
  }

  const start = (ctx: TenantContext, id: string, userId: string) =>
    startReconnect(ctx, {
      socialAccountId: id,
      userId,
      redirectUri: 'https://app.test/api/v1/social/oauth/facebook/callback',
    });

  it('issues an authorization url and a state nonce', async () => {
    const id = await connectOne();

    const result = await start(ctxA, id, USER_A);

    expect(result.authorizationUrl).toContain('state=');
    expect(result.nonce.length).toBeGreaterThan(0);
    expect(result.scopes.length).toBeGreaterThan(0);
  });

  it('never returns token material', async () => {
    const id = await connectOne();

    const result = await start(ctxA, id, USER_A);

    expect(JSON.stringify(result)).not.toContain('page-token');
  });

  it('binds the state to the account’s own workspace and brand', async () => {
    // The caller supplies one id and nothing else, so there is no field through
    // which a reconnect could be aimed at another workspace's brand.
    const id = await connectOne();

    const result = await start(ctxA, id, USER_A);
    const state = new URL(result.authorizationUrl).searchParams.get('state');
    const [encoded] = state!.split('.');
    const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as {
      organizationId: string;
      workspaceId: string;
      brandId: string;
      userId: string;
    };

    expect(payload).toMatchObject({
      organizationId: ORG_A,
      workspaceId: WS_A,
      brandId: BRAND_A,
      userId: USER_A,
    });
  });

  it('does not find an account from another tenant', async () => {
    const id = await connectOne();
    await expect(start(ctxB, id, USER_B)).rejects.toThrow(NotFoundError);
  });

  it('refuses to reconnect an account that was disconnected', async () => {
    const id = await connectOne();
    await disconnectAccount(ctxA, id, fingerprint);

    // Soft-deleted, so it is simply not found — a disconnected account starts over.
    await expect(start(ctxA, id, USER_A)).rejects.toThrow(NotFoundError);
  });
});

describe('disconnecting', () => {
  async function connectOne() {
    await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1')],
    });
    const [row] = await platformDb.socialAccount.findMany({ where: { organizationId: ORG_A } });
    await connectAccounts(
      ctxA,
      { platform: 'FACEBOOK', workspaceId: WS_A, brandId: BRAND_A, socialAccountIds: [row!.id] },
      fingerprint,
    );
    return row!.id;
  }

  it('removes the credential and soft-deletes the account', async () => {
    const id = await connectOne();
    await disconnectAccount(ctxA, id, fingerprint);

    expect(await platformDb.socialCredential.count({ where: { socialAccountId: id } })).toBe(0);

    // The row survives so published history keeps its reference.
    const row = await platformDb.socialAccount.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('REVOKED');
    expect(row.deletedAt).not.toBeNull();
    expect(await listAccounts(ctxA)).toHaveLength(0);
  });

  it('refuses while scheduled posts still reference the account', async () => {
    const id = await connectOne();

    const post = await platformDb.post.create({
      data: {
        organizationId: ORG_A,
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'queued',
        status: 'SCHEDULED',
      },
    });
    await platformDb.postVariant.create({
      data: {
        organizationId: ORG_A,
        postId: post.id,
        socialAccountId: id,
        platform: 'FACEBOOK',
        status: 'SCHEDULED',
        scheduledFor: new Date(Date.now() + 3_600_000),
      },
    });

    await expect(disconnectAccount(ctxA, id, fingerprint)).rejects.toThrow(ConflictError);

    // Still connected, and its credential intact.
    expect(await platformDb.socialCredential.count({ where: { socialAccountId: id } })).toBe(1);
  });

  it('succeeds even when the provider refuses to revoke', async () => {
    const id = await connectOne();
    mock.fault = 'UNAVAILABLE';

    // A revoked-at-Meta account must still be removable locally, or it could
    // never be cleaned up.
    await expect(disconnectAccount(ctxA, id, fingerprint)).resolves.toBeUndefined();
  });

  it('does not disconnect another tenant’s account', async () => {
    const id = await connectOne();
    await expect(disconnectAccount(ctxB, id, fingerprint)).rejects.toThrow(NotFoundError);
    expect(await platformDb.socialCredential.count({ where: { socialAccountId: id } })).toBe(1);
  });
});

describe('discarding staged accounts', () => {
  it('removes staged rows and their credentials', async () => {
    await stageDiscoveredAccounts(ctxA, {
      platform: 'FACEBOOK',
      workspaceId: WS_A,
      brandId: BRAND_A,
      discovered: [discovered('page-1'), discovered('page-2')],
    });

    const removed = await discardStagedAccounts(ctxA, { platform: 'FACEBOOK', keepIds: [] });
    expect(removed).toBe(2);
    expect(await platformDb.socialCredential.count({ where: { organizationId: ORG_A } })).toBe(0);
  });

  it('leaves another tenant’s staged rows alone', async () => {
    await stageDiscoveredAccounts(ctxB, {
      platform: 'FACEBOOK',
      workspaceId: WS_B,
      brandId: BRAND_B,
      discovered: [discovered('page-b')],
    });

    await discardStagedAccounts(ctxA, { platform: 'FACEBOOK', keepIds: [] });
    expect(await platformDb.socialAccount.count({ where: { organizationId: ORG_B } })).toBe(1);
  });
});
