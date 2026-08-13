import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, devIdentityProvider } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import {
  closeQueues,
  closeSharedConnection,
  listDeadLetters,
  recordDeadLetter,
  redis,
} from '@orbit/queue';
import { GET as getOrganizations } from '../../../app/api/v1/admin/organizations/route';
import { GET as getUsers } from '../../../app/api/v1/admin/users/route';
import { GET as getAccounts } from '../../../app/api/v1/admin/social-accounts/route';
import { GET as getHealth } from '../../../app/api/v1/admin/health/route';
import { GET as getJobs } from '../../../app/api/v1/admin/jobs/route';
import { GET as getJob } from '../../../app/api/v1/admin/jobs/[jobId]/route';
import { POST as retryJobRoute } from '../../../app/api/v1/admin/jobs/[jobId]/retry/route';
import { POST as discardJobRoute } from '../../../app/api/v1/admin/jobs/[jobId]/discard/route';

/**
 * The platform admin surface at the HTTP boundary (SRS §28, T1.18).
 *
 * Three things are proved here, and they are the three the task asks for:
 *
 *  1. **Non-admins get 404 on every admin route** — not 403, so the surface is
 *     not discoverable.
 *  2. **No admin response contains credential material, masked or otherwise**,
 *     nor any client content. Asserted on the serialised payload.
 *  3. **Every tenant-data action is audited with an actor and a reason**, in the
 *     affected organization's own audit log.
 */

const ORG = '018ffb10-0000-7000-8000-0000fb100001';
const WS = '018ffb10-0000-7000-8000-0000fb100002';
const BRAND = '018ffb10-0000-7000-8000-0000fb100003';
const ACCOUNT = '018ffb10-0000-7000-8000-0000fb100004';
const POST_ID = '018ffb10-0000-7000-8000-0000fb100005';

const ADMIN = '018ffb10-0000-7000-8000-0000fb100010';
const OWNER = '018ffb10-0000-7000-8000-0000fb100011';

const SECRET_TOKEN = 'EAAG-super-secret-page-token';
const POST_BODY = 'The confidential spring campaign copy.';

let adminSession: string;
let ownerSession: string;

function request(path: string, init: { cookie?: string; body?: unknown } = {}): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.cookie) headers.set('cookie', `${SESSION_COOKIE_NAME}=${init.cookie}`);

  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.body ? 'POST' : 'GET',
    headers,
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = <P>(value: P) => ({ params: Promise.resolve(value) });

async function read(response: Response) {
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as unknown) : null, text };
}

async function flushDeadLetters() {
  const connection = redis();
  let cursor = '0';
  do {
    const [next, keys] = await connection.scan(cursor, 'MATCH', 'dlq:*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) await connection.del(...keys);
  } while (cursor !== '0');
}

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';

  await platformDb.organization.upsert({
    where: { id: ORG },
    update: {},
    create: { id: ORG, name: 't18', slug: 't18', timezone: 'UTC' },
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

  await platformDb.user.upsert({
    where: { id: ADMIN },
    update: { isPlatformAdmin: true },
    create: {
      id: ADMIN,
      firebaseUid: 'dev:admin@t18.test',
      email: 'admin@t18.test',
      isPlatformAdmin: true,
    },
  });
  await platformDb.user.upsert({
    where: { id: OWNER },
    update: { isPlatformAdmin: false },
    create: { id: OWNER, firebaseUid: 'dev:owner@t18.test', email: 'owner@t18.test' },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: ORG, userId: OWNER } },
    update: { role: 'OWNER', status: 'ACTIVE' },
    create: { organizationId: ORG, userId: OWNER, role: 'OWNER', status: 'ACTIVE' },
  });

  // An account with a real sealed credential, so "no credential material" is
  // asserted against a database that actually holds some.
  await platformDb.socialAccount.upsert({
    where: { id: ACCOUNT },
    update: { status: 'NEEDS_RECONNECT' },
    create: {
      id: ACCOUNT,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      platform: 'FACEBOOK',
      externalId: '1234567890-secret-page-id',
      displayName: 'Acme Bakery Confidential',
      handle: 'acme-private',
      accountType: 'PAGE',
      status: 'NEEDS_RECONNECT',
      healthError: 'The token was revoked by the user.',
    },
  });

  const { CredentialCipher } = await import('@orbit/providers');
  const sealed = new CredentialCipher().seal(SECRET_TOKEN, {
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
      scopes: ['pages_manage_posts'],
    },
  });

  await platformDb.post.upsert({
    where: { id: POST_ID },
    update: {},
    create: {
      id: POST_ID,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      title: 'Confidential campaign',
      body: POST_BODY,
      status: 'DRAFT',
    },
  });

  adminSession = await devIdentityProvider.createSessionCookie('dev:admin@t18.test', 3_600_000);
  ownerSession = await devIdentityProvider.createSessionCookie('dev:owner@t18.test', 3_600_000);
});

beforeEach(async () => {
  await platformDb.auditLog.deleteMany({ where: { organizationId: ORG } });
  await flushDeadLetters();
});

afterAll(async () => {
  await flushDeadLetters();
  await platformDb.organization.deleteMany({ where: { id: ORG } });
  await platformDb.user.deleteMany({ where: { id: { in: [ADMIN, OWNER] } } });
  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

/** Seed one dead letter and return its id. */
async function seedDeadLetter(
  queue: 'media' | 'publish' = 'media',
  organizationId: string | null = ORG,
) {
  const entry = await recordDeadLetter({
    queue,
    jobId: `job-${queue}-1`,
    organizationId,
    correlationId: 'itest-admin',
    error: new Error('storage unavailable'),
    reason: 'ATTEMPTS_EXHAUSTED',
    attempts: 4,
    payload:
      queue === 'media'
        ? {
            organizationId: ORG,
            correlationId: 'itest-admin',
            mediaAssetId: '018ffb10-0000-7000-8000-0000fb100099',
          }
        : {
            organizationId: ORG,
            correlationId: 'itest-admin',
            postVariantId: '018ffb10-0000-7000-8000-0000fb100098',
            idempotencyKey: 'k',
            publishingJobId: '018ffb10-0000-7000-8000-0000fb100097',
          },
  });

  return entry.id;
}

// ── Nobody else gets in ─────────────────────────────────────────────────────

describe('access', () => {
  const routes: Array<[string, () => Promise<Response>]> = [];

  it('gives a non-admin 404 on every admin route', async () => {
    const cases: Array<[string, Promise<Response>]> = [
      [
        'organizations',
        getOrganizations(request('/api/v1/admin/organizations', { cookie: ownerSession })),
      ],
      ['users', getUsers(request('/api/v1/admin/users', { cookie: ownerSession }))],
      [
        'social-accounts',
        getAccounts(request('/api/v1/admin/social-accounts', { cookie: ownerSession })),
      ],
      ['health', getHealth(request('/api/v1/admin/health', { cookie: ownerSession }))],
      ['jobs', getJobs(request('/api/v1/admin/jobs', { cookie: ownerSession }))],
    ];

    for (const [label, promise] of cases) {
      const { status } = await read(await promise);
      // 404, never 403 — an Owner learns nothing about the admin API's shape.
      expect(status, label).toBe(404);
    }

    expect(routes).toHaveLength(0);
  });

  it('gives an unauthenticated caller 401', async () => {
    const { status } = await read(await getHealth(request('/api/v1/admin/health')));
    expect(status).toBe(401);
  });

  it('refuses a non-admin the mutating routes too', async () => {
    const id = await seedDeadLetter();

    const retry = await read(
      await retryJobRoute(
        request(`/api/v1/admin/jobs/${encodeURIComponent(id)}/retry`, {
          cookie: ownerSession,
          body: { reason: 'trying it on' },
        }),
        params({ jobId: encodeURIComponent(id) }),
      ),
    );

    expect(retry.status).toBe(404);
    // Nothing happened, and nothing was written to the tenant's audit log.
    expect(await platformDb.auditLog.count({ where: { organizationId: ORG } })).toBe(0);
    expect(await listDeadLetters()).toHaveLength(1);
  });

  it('lets a platform admin in', async () => {
    const { status } = await read(
      await getHealth(request('/api/v1/admin/health', { cookie: adminSession })),
    );
    expect(status).toBe(200);
  });
});

// ── Nothing sensitive comes back ────────────────────────────────────────────

describe('what an admin can see', () => {
  /** Values that must never appear in an admin payload. */
  const FORBIDDEN = [
    SECRET_TOKEN,
    'accessTokenCiphertext',
    'accessTokenIv',
    'accessTokenAuthTag',
    'keyVersion',
    'refreshToken',
    POST_BODY,
    'Confidential campaign',
    // docs/RBAC.md §3 note 2: status only, so not the account's identity either.
    'Acme Bakery Confidential',
    'acme-private',
    '1234567890-secret-page-id',
    'The token was revoked by the user.',
    // Authentication identifiers have no support purpose.
    'firebaseUid',
  ];

  it('returns no credential material and no client content, on any route', async () => {
    await seedDeadLetter();

    const responses = await Promise.all([
      getOrganizations(request('/api/v1/admin/organizations', { cookie: adminSession })),
      getUsers(request('/api/v1/admin/users', { cookie: adminSession })),
      getAccounts(request('/api/v1/admin/social-accounts', { cookie: adminSession })),
      getHealth(request('/api/v1/admin/health', { cookie: adminSession })),
      getJobs(request('/api/v1/admin/jobs', { cookie: adminSession })),
    ]);

    for (const response of responses) {
      const { status, text } = await read(response);
      expect(status).toBe(200);

      for (const forbidden of FORBIDDEN) {
        expect(text, `leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('shows connection status and the organization, and nothing identifying', async () => {
    const { json } = await read(
      await getAccounts(request('/api/v1/admin/social-accounts', { cookie: adminSession })),
    );

    const body = json as {
      accounts: Array<{ status: string; platform: string; organization: { name: string } }>;
    };
    const account = body.accounts.find((a) => a.organization.name === 't18');

    expect(account?.status).toBe('NEEDS_RECONNECT');
    expect(account?.platform).toBe('FACEBOOK');
  });

  it('counts a tenant’s posts without returning any of them', async () => {
    const { json, text } = await read(
      await getOrganizations(request('/api/v1/admin/organizations', { cookie: adminSession })),
    );

    const body = json as { organizations: Array<{ slug: string; _count: { posts: number } }> };
    const org = body.organizations.find((o) => o.slug === 't18');

    expect(org?._count.posts).toBe(1);
    expect(text).not.toContain(POST_BODY);
  });
});

// ── Acting on a dead letter ─────────────────────────────────────────────────

describe('retrying', () => {
  it('re-enqueues, and audits it against the tenant with a reason', async () => {
    const id = await seedDeadLetter('media');

    const { status } = await read(
      await retryJobRoute(
        request(`/api/v1/admin/jobs/${encodeURIComponent(id)}/retry`, {
          cookie: adminSession,
          body: { reason: 'S3 outage during OPS-812; the upload is fine now.' },
        }),
        params({ jobId: encodeURIComponent(id) }),
      ),
    );

    expect(status).toBe(200);

    // The entry is gone: the dead-letter set lists what is still wrong.
    expect(await listDeadLetters()).toHaveLength(0);

    const audits = await platformDb.auditLog.findMany({ where: { organizationId: ORG } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.action).toBe('admin.job_retried');
    // The actor is the person, in the customer's own audit log.
    expect(audits[0]?.actorUserId).toBe(ADMIN);
    expect(audits[0]?.reason).toContain('OPS-812');
  });

  it('refuses without a reason, and does nothing', async () => {
    const id = await seedDeadLetter('media');

    const { status } = await read(
      await retryJobRoute(
        request(`/api/v1/admin/jobs/${encodeURIComponent(id)}/retry`, {
          cookie: adminSession,
          body: {},
        }),
        params({ jobId: encodeURIComponent(id) }),
      ),
    );

    expect(status).toBe(400);
    expect(await listDeadLetters()).toHaveLength(1);
    expect(await platformDb.auditLog.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('refuses a reason too short to mean anything', async () => {
    const id = await seedDeadLetter('media');

    const { status } = await read(
      await retryJobRoute(
        request(`/api/v1/admin/jobs/${encodeURIComponent(id)}/retry`, {
          cookie: adminSession,
          body: { reason: 'fix' },
        }),
        params({ jobId: encodeURIComponent(id) }),
      ),
    );

    expect(status).toBe(400);
    expect(await listDeadLetters()).toHaveLength(1);
  });

  it('refuses to retry a publish job from here', async () => {
    // Decision D-045: publishing keeps exactly one door, and it is the tenant's.
    const id = await seedDeadLetter('publish');

    const { status, json } = await read(
      await retryJobRoute(
        request(`/api/v1/admin/jobs/${encodeURIComponent(id)}/retry`, {
          cookie: adminSession,
          body: { reason: 'Customer asked us to push it through.' },
        }),
        params({ jobId: encodeURIComponent(id) }),
      ),
    );

    expect(status).toBe(400);
    expect((json as { error: { message: string } }).error.message).toContain('publishing log');

    // Still there, and still not published.
    expect(await listDeadLetters()).toHaveLength(1);
  });

  it('reports a publish job as not retryable', async () => {
    const id = await seedDeadLetter('publish');

    const { json } = await read(
      await getJob(
        request(`/api/v1/admin/jobs/${encodeURIComponent(id)}`, { cookie: adminSession }),
        params({ jobId: encodeURIComponent(id) }),
      ),
    );

    expect((json as { retryable: boolean }).retryable).toBe(false);
  });

  it('discards, and audits that too', async () => {
    const id = await seedDeadLetter('media');

    const { status } = await read(
      await discardJobRoute(
        request(`/api/v1/admin/jobs/${encodeURIComponent(id)}/discard`, {
          cookie: adminSession,
          body: { reason: 'Duplicate of OPS-812, already resolved.' },
        }),
        params({ jobId: encodeURIComponent(id) }),
      ),
    );

    expect(status).toBe(200);
    expect(await listDeadLetters()).toHaveLength(0);

    const audits = await platformDb.auditLog.findMany({ where: { organizationId: ORG } });
    expect(audits[0]?.action).toBe('admin.job_discarded');
    expect(audits[0]?.actorUserId).toBe(ADMIN);
  });

  it('handles a platform job that belongs to no tenant', async () => {
    const id = await seedDeadLetter('media', null);

    const { status } = await read(
      await retryJobRoute(
        request(`/api/v1/admin/jobs/${encodeURIComponent(id)}/retry`, {
          cookie: adminSession,
          body: { reason: 'Maintenance sweep failed on a transient blip.' },
        }),
        params({ jobId: encodeURIComponent(id) }),
      ),
    );

    expect(status).toBe(200);
    // No tenant, so no tenant audit log — the security log carries it instead.
    expect(await platformDb.auditLog.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
