import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAIM_TTL_MS,
  contentHash,
  fixedClock,
  publishIdempotencyKey,
  setClock,
} from '@orbit/core';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection, redis } from '@orbit/queue';
import { registerProvider, resetRegistry } from '@orbit/providers';
import { MockProvider } from '@orbit/providers/mock';
import { publishVariant } from './engine.js';
import { claimVariant, releaseClaim } from './claim.js';
import { rollUpPost } from './rollup.js';

/**
 * The publishing engine against real Postgres, real Redis and the mock
 * provider's fault injection (T1.13).
 *
 * These are the tests the whole design exists to pass. The two that matter most
 * are `TIMEOUT_THEN_PUBLISHED` — where a blind retry would double-post — and
 * concurrent workers on one variant, where layer 2 is the only thing standing
 * between us and two posts.
 */

const ORG = '018ff100-0000-7000-8000-0000f1000001';
const ORG_B = '018ff200-0000-7000-8000-0000f2000001';
const WS = '018ff100-0000-7000-8000-0000f1000002';
const BRAND = '018ff100-0000-7000-8000-0000f1000003';
const ACCOUNT = '018ff100-0000-7000-8000-0000f1000004';
const ACCOUNT_2 = '018ff100-0000-7000-8000-0000f1000009';
const POST = '018ff100-0000-7000-8000-0000f1000005';
const VARIANT = '018ff100-0000-7000-8000-0000f1000006';
const VARIANT_2 = '018ff100-0000-7000-8000-0000f100000a';
const JOB = '018ff100-0000-7000-8000-0000f1000007';
const JOB_2 = '018ff100-0000-7000-8000-0000f100000b';
const OWNER = '018ff100-0000-7000-8000-0000f100000c';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const BODY = 'A perfectly ordinary announcement.';
const HASH = contentHash({ body: BODY });

let mock: MockProvider;
let restoreClock: (() => void) | undefined;

function jobContext(overrides: Partial<{ variantId: string; jobId: string; org: string }> = {}) {
  return {
    payload: {
      organizationId: overrides.org ?? ORG,
      correlationId: 'itest-publish',
      postVariantId: overrides.variantId ?? VARIANT,
      idempotencyKey: publishIdempotencyKey({
        postVariantId: overrides.variantId ?? VARIANT,
        scheduledFor: NOW,
        contentHash: HASH,
      }),
      publishingJobId: overrides.jobId ?? JOB,
    },
    attempt: 1,
    jobId: 'queue-job-1',
    correlationId: 'itest-publish',
  };
}

async function flushRedis() {
  const connection = redis();
  for (const pattern of ['bull:*', 'lock:publish:*', 'ratelimit:*', 'dlq:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await connection.del(...keys);
    } while (cursor !== '0');
  }
}

/** A scheduled variant with a credential, ready for the engine to claim. */
async function seedScheduled(
  options: { variantId?: string; accountId?: string; jobId?: string; status?: 'SCHEDULED' } = {},
) {
  const variantId = options.variantId ?? VARIANT;
  const accountId = options.accountId ?? ACCOUNT;
  const jobId = options.jobId ?? JOB;

  await platformDb.postVariant.create({
    data: {
      id: variantId,
      organizationId: ORG,
      postId: POST,
      socialAccountId: accountId,
      platform: 'FACEBOOK',
      body: '',
      status: options.status ?? 'SCHEDULED',
      scheduledFor: NOW,
      contentHash: HASH,
    },
  });

  await platformDb.publishingJob.create({
    data: {
      id: jobId,
      organizationId: ORG,
      postVariantId: variantId,
      idempotencyKey: publishIdempotencyKey({
        postVariantId: variantId,
        scheduledFor: NOW,
        contentHash: HASH,
      }),
      scheduledFor: NOW,
      state: 'QUEUED',
    },
  });
}

async function seedAccount(id: string, externalId: string) {
  await platformDb.socialAccount.upsert({
    where: { id },
    update: { status: 'ACTIVE' },
    create: {
      id,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      platform: 'FACEBOOK',
      externalId,
      displayName: externalId,
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });

  // A credential the engine can decrypt. Sealed with the same AAD the loader
  // uses, so a row moved between tenants would fail to open.
  const { CredentialCipher } = await import('@orbit/providers');
  const cipher = new CredentialCipher();
  const sealed = cipher.seal('mock-access-token', {
    organizationId: ORG,
    socialAccountId: id,
  });

  await platformDb.socialCredential.upsert({
    where: { socialAccountId: id },
    update: {},
    create: {
      organizationId: ORG,
      socialAccountId: id,
      accessTokenCiphertext: new Uint8Array(sealed.ciphertext),
      accessTokenIv: new Uint8Array(sealed.iv),
      accessTokenAuthTag: new Uint8Array(sealed.authTag),
      keyVersion: sealed.keyVersion,
      scopes: ['mock_publish'],
    },
  });
}

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';

  await platformDb.organization.upsert({
    where: { id: ORG },
    update: {},
    create: { id: ORG, name: 't13', slug: 't13', timezone: 'UTC' },
  });
  await platformDb.organization.upsert({
    where: { id: ORG_B },
    update: {},
    create: { id: ORG_B, name: 't13b', slug: 't13b', timezone: 'UTC' },
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

  await seedAccount(ACCOUNT, 'page-one');
  await seedAccount(ACCOUNT_2, 'page-two');

  // An Owner, so the health notifications T1.7 writes have somewhere to go.
  await platformDb.user.upsert({
    where: { id: OWNER },
    update: {},
    create: { id: OWNER, firebaseUid: 'dev:t13owner@t13.test', email: 't13owner@t13.test' },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: ORG, userId: OWNER } },
    update: { role: 'OWNER', status: 'ACTIVE' },
    create: { organizationId: ORG, userId: OWNER, role: 'OWNER', status: 'ACTIVE' },
  });
});

beforeEach(async () => {
  restoreClock = setClock(fixedClock(NOW));

  resetRegistry();
  mock = new MockProvider();
  registerProvider(mock, { developmentOnly: true });

  await platformDb.publishingAttempt.deleteMany({ where: { organizationId: ORG } });
  await platformDb.publishingJob.deleteMany({ where: { organizationId: ORG } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: ORG } });
  await platformDb.post.deleteMany({ where: { organizationId: ORG } });
  await platformDb.auditLog.deleteMany({ where: { organizationId: ORG } });
  await platformDb.notification.deleteMany({ where: { organizationId: ORG } });

  // A failed publish can now demote its account (T1.7), so health has to be
  // reset between tests or one auth failure would leak into every later case.
  await platformDb.socialAccount.updateMany({
    where: { organizationId: ORG },
    data: { status: 'ACTIVE', healthError: null, healthCheckedAt: null },
  });

  await flushRedis();

  await platformDb.post.create({
    data: {
      id: POST,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      body: BODY,
      status: 'SCHEDULED',
      scheduledFor: NOW,
      timezone: 'UTC',
    },
  });
});

afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
});

afterAll(async () => {
  await flushRedis();
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { id: OWNER } });
  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

// ── The happy path ──────────────────────────────────────────────────────────

describe('publishing', () => {
  it('publishes and records the external id', async () => {
    await seedScheduled();

    const result = await publishVariant(jobContext());

    expect(result.kind).toBe('PUBLISHED');
    expect(mock.callCounts.publish).toBe(1);

    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(variant?.status).toBe('PUBLISHED');
    expect(variant?.externalPostId).toBeTruthy();
    expect(variant?.publishedAt).not.toBeNull();
    // The claim is released on settle, so nothing is left holding the row.
    expect(variant?.claimToken).toBeNull();
    expect(variant?.claimedAt).toBeNull();
  });

  it('settles the job and the attempt ledger', async () => {
    await seedScheduled();
    await publishVariant(jobContext());

    const job = await platformDb.publishingJob.findUnique({ where: { id: JOB } });
    expect(job?.state).toBe('SUCCEEDED');
    expect(job?.attemptCount).toBe(1);

    const attempts = await platformDb.publishingAttempt.findMany({
      where: { publishingJobId: JOB },
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ state: 'SUCCEEDED', attemptNumber: 1 });
    expect(attempts[0]?.finishedAt).not.toBeNull();
    expect(attempts[0]?.durationMs).not.toBeNull();
  });

  it('rolls the post up to PUBLISHED and audits it', async () => {
    await seedScheduled();
    await publishVariant(jobContext());

    const post = await platformDb.post.findUnique({ where: { id: POST } });
    expect(post?.status).toBe('PUBLISHED');
    expect(post?.publishedAt).not.toBeNull();

    const entry = await platformDb.auditLog.findFirst({
      where: { organizationId: ORG, action: 'post.publish_settled' },
    });
    expect(entry?.actorType).toBe('WORKER');
  });
});

// ── Layer 2: the atomic claim ───────────────────────────────────────────────

describe('idempotency layer 2 — the atomic claim', () => {
  it('two concurrent workers produce exactly one publish', async () => {
    // The guarantee. Everything else is optimisation or recovery.
    await seedScheduled();

    const results = await Promise.all([
      publishVariant(jobContext()),
      publishVariant(jobContext()),
      publishVariant(jobContext()),
    ]);

    expect(mock.callCounts.publish).toBe(1);
    expect(mock.posts.size).toBe(1);

    expect(results.filter((r) => r.kind === 'PUBLISHED')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'NOT_CLAIMABLE')).toHaveLength(2);
  });

  it('a duplicate job after a successful publish does not publish again', async () => {
    await seedScheduled();
    await publishVariant(jobContext());

    const second = await publishVariant(jobContext());

    expect(second.kind).toBe('NOT_CLAIMABLE');
    expect(mock.callCounts.publish).toBe(1);
  });

  it('does not publish a variant that was unscheduled', async () => {
    await seedScheduled();
    await platformDb.postVariant.update({
      where: { id: VARIANT },
      data: { status: 'DRAFT' },
    });

    const result = await publishVariant(jobContext());

    // This is what makes queue cancellation safe as best-effort (T1.12).
    expect(result.kind).toBe('NOT_CLAIMABLE');
    expect(mock.callCounts.publish).toBe(0);
  });

  it('does not publish a variant that was cancelled', async () => {
    await seedScheduled();
    await platformDb.postVariant.update({
      where: { id: VARIANT },
      data: { status: 'CANCELED' },
    });

    expect((await publishVariant(jobContext())).kind).toBe('NOT_CLAIMABLE');
    expect(mock.callCounts.publish).toBe(0);
  });

  it('refuses to claim a variant a live worker already holds', async () => {
    await seedScheduled();

    const first = await claimVariant(VARIANT, NOW);
    expect(first.status).toBe('CLAIMED');

    const second = await claimVariant(VARIANT, NOW);
    expect(second.status).toBe('NOT_AVAILABLE');
  });

  it('takes over a claim whose worker died, and flags it for reconciliation', async () => {
    await seedScheduled();

    await claimVariant(VARIANT, NOW);
    const later = new Date(NOW.getTime() + CLAIM_TTL_MS + 1_000);

    const takeover = await claimVariant(VARIANT, later);
    expect(takeover.status).toBe('ABANDONED');
  });

  it('a released claim can be taken again', async () => {
    await seedScheduled();

    const claim = await claimVariant(VARIANT, NOW);
    expect(claim.status).toBe('CLAIMED');
    if (claim.status !== 'CLAIMED') return;

    expect(await releaseClaim(claim.claim)).toBe(true);
    expect((await claimVariant(VARIANT, NOW)).status).toBe('CLAIMED');
  });

  it('a stale claim holder cannot release the new owner claim', async () => {
    await seedScheduled();

    const first = await claimVariant(VARIANT, NOW);
    if (first.status !== 'CLAIMED') throw new Error('expected a claim');

    const later = new Date(NOW.getTime() + CLAIM_TTL_MS + 1_000);
    const second = await claimVariant(VARIANT, later);
    expect(second.status).toBe('ABANDONED');

    // The token guard: the old holder's release must not touch the new owner.
    expect(await releaseClaim(first.claim)).toBe(false);

    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(variant?.status).toBe('PUBLISHING');
  });
});

// ── Layer 4: reconciliation ─────────────────────────────────────────────────

describe('idempotency layer 4 — reconciliation', () => {
  it('TIMEOUT_THEN_PUBLISHED does not double-post', async () => {
    // The dangerous case: the post landed, the caller never learned of it.
    // A blind retry here is a duplicate on the client's Page.
    await seedScheduled();
    mock.fault = 'TIMEOUT_THEN_PUBLISHED';

    const result = await publishVariant(jobContext());

    // Exactly one post exists at the provider, and we found it.
    expect(mock.posts.size).toBe(1);
    expect(mock.callCounts.publish).toBe(1);
    expect(mock.callCounts.reconcile).toBe(1);
    expect(result.kind).toBe('PUBLISHED');

    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(variant?.status).toBe('PUBLISHED');
    expect(variant?.externalPostId).toBeTruthy();
  });

  it('records a reconciled publish as RECONCILED, not SUCCEEDED', async () => {
    // The distinction matters when reading the trail: it succeeded, but we
    // learned of it after the fact.
    await seedScheduled();
    mock.fault = 'TIMEOUT_THEN_PUBLISHED';

    await publishVariant(jobContext());

    const attempts = await platformDb.publishingAttempt.findMany({
      where: { publishingJobId: JOB },
    });
    expect(attempts[0]?.state).toBe('RECONCILED');
    expect(attempts[0]?.externalPostId).toBeTruthy();
  });

  it('TIMEOUT_NOT_PUBLISHED is safe to retry, and the retry publishes once', async () => {
    await seedScheduled();
    mock.fault = 'TIMEOUT_NOT_PUBLISHED';

    const first = await publishVariant(jobContext());

    // Reconciliation confirmed nothing went out, so this is retryable.
    expect(first.kind).toBe('DEFERRED');
    expect(mock.posts.size).toBe(0);
    expect(mock.callCounts.reconcile).toBe(1);

    // The variant went back to SCHEDULED so the retry can claim it.
    const afterFirst = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(afterFirst?.status).toBe('SCHEDULED');

    // The retry succeeds, and there is exactly one post.
    const second = await publishVariant(jobContext());
    expect(second.kind).toBe('PUBLISHED');
    expect(mock.posts.size).toBe(1);
  });

  it('parks the variant when the provider cannot say', async () => {
    await seedScheduled();
    mock.fault = 'TIMEOUT_THEN_PUBLISHED';

    // Make reconciliation itself fail: now we know less than before, and the
    // only safe answer is to stop and ask a human.
    mock.reconcile = () => Promise.reject(new Error('reconcile unavailable'));

    const result = await publishVariant(jobContext());

    expect(result.kind).toBe('PARKED');

    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(variant?.status).toBe('NEEDS_REVIEW');

    const attempts = await platformDb.publishingAttempt.findMany({
      where: { publishingJobId: JOB },
    });
    expect(attempts[0]?.state).toBe('INCONCLUSIVE');
  });

  it('never re-publishes a parked variant', async () => {
    await seedScheduled();
    mock.fault = 'TIMEOUT_THEN_PUBLISHED';
    mock.reconcile = () => Promise.reject(new Error('reconcile unavailable'));

    await publishVariant(jobContext());
    const publishesAfterPark = mock.callCounts.publish;

    // A duplicate job arriving later must not touch it.
    const again = await publishVariant(jobContext());

    expect(again.kind).toBe('NOT_CLAIMABLE');
    expect(mock.callCounts.publish).toBe(publishesAfterPark);
  });

  it('reconciles an orphaned IN_FLIGHT attempt instead of publishing', async () => {
    // The worker-crash case: an attempt row exists with no outcome, and the
    // post may or may not have gone out.
    await seedScheduled();

    await platformDb.publishingAttempt.create({
      data: {
        organizationId: ORG,
        publishingJobId: JOB,
        attemptNumber: 1,
        state: 'IN_FLIGHT',
        correlationId: 'crashed-worker',
        startedAt: NOW,
      },
    });

    // The provider *did* receive it before the worker died.
    mock.posts.set('recovered-1', {
      externalPostId: 'recovered-1',
      accountExternalId: 'page-one',
      body: BODY,
      contentHash: HASH,
      publishedAt: NOW,
      createdByThisApp: true,
    });

    const result = await publishVariant(jobContext());

    // Recovered without a second publish.
    expect(result.kind).toBe('PUBLISHED');
    expect(mock.callCounts.publish).toBe(0);
    expect(mock.posts.size).toBe(1);

    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(variant?.externalPostId).toBe('recovered-1');
  });

  it('publishes normally when an orphaned attempt demonstrably never landed', async () => {
    await seedScheduled();

    await platformDb.publishingAttempt.create({
      data: {
        organizationId: ORG,
        publishingJobId: JOB,
        attemptNumber: 1,
        state: 'IN_FLIGHT',
        correlationId: 'crashed-worker',
        startedAt: NOW,
      },
    });

    const result = await publishVariant(jobContext());

    expect(result.kind).toBe('PUBLISHED');
    expect(mock.callCounts.reconcile).toBe(1);
    expect(mock.callCounts.publish).toBe(1);
    expect(mock.posts.size).toBe(1);
  });

  it('matches reconciliation on the content hash, not just the account', async () => {
    await seedScheduled();
    mock.fault = 'TIMEOUT_NOT_PUBLISHED';

    // A different post on the same Page must not be mistaken for ours.
    mock.posts.set('someone-elses', {
      externalPostId: 'someone-elses',
      accountExternalId: 'page-one',
      body: 'A completely different post',
      contentHash: contentHash({ body: 'A completely different post' }),
      publishedAt: NOW,
      createdByThisApp: true,
    });

    const result = await publishVariant(jobContext());

    // NOT_FOUND, so retryable — it did not adopt the unrelated post.
    expect(result.kind).toBe('DEFERRED');

    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(variant?.externalPostId).toBeNull();
  });
});

// ── Failure classification ──────────────────────────────────────────────────

describe('failure classification', () => {
  it('does not retry an authentication error', async () => {
    await seedScheduled();
    mock.fault = 'AUTH_EXPIRED';

    const result = await publishVariant(jobContext());

    expect(result.kind).toBe('FAILED');

    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(variant?.status).toBe('FAILED');
    expect(JSON.stringify(variant?.lastError)).toContain('PROVIDER_AUTHENTICATION_ERROR');

    const job = await platformDb.publishingJob.findUnique({ where: { id: JOB } });
    expect(job?.state).toBe('FAILED');
  });

  it('marks the account as needing reconnection after an authentication error', async () => {
    // T1.7. Before this, a dead token failed one post, left the account ACTIVE,
    // and then failed the next post identically — the publishing log filled up
    // while the accounts page reported everything fine.
    await seedScheduled();
    mock.fault = 'AUTH_EXPIRED';

    await publishVariant(jobContext());

    const account = await platformDb.socialAccount.findUniqueOrThrow({ where: { id: ACCOUNT } });
    expect(account.status).toBe('NEEDS_RECONNECT');
    expect(account.healthError).toBeTruthy();
    expect(account.healthCheckedAt).not.toBeNull();

    // The person who can fix it is told, in the same transaction (T1.15 delivers).
    const notifications = await platformDb.notification.findMany({
      where: { organizationId: ORG, resourceId: ACCOUNT },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.userId).toBe(OWNER);
    expect(notifications[0]?.type).toBe('social_account.needs_reconnect');

    const audits = await platformDb.auditLog.findMany({
      where: { organizationId: ORG, action: 'social_account.health_degraded' },
    });
    expect(audits).toHaveLength(1);
  });

  /**
   * The distinction this test exists for: a permission failure about **our app**
   * is not a broken connection.
   *
   * TikTok refuses a public post from an unaudited client with a 403 that maps
   * to `PROVIDER_PERMISSION_ERROR` — and the account is perfectly healthy.
   * Demoting on it took a working TikTok account out of service in production
   * and told an account manager to reconnect it, which resolves nothing.
   */
  it('leaves the account alone when the refusal was about the app, not the connection', async () => {
    await seedScheduled();
    mock.fault = 'CLIENT_STANDING';

    expect((await publishVariant(jobContext())).kind).toBe('FAILED');

    const account = await platformDb.socialAccount.findUniqueOrThrow({ where: { id: ACCOUNT } });
    expect(account.status).toBe('ACTIVE');
    expect(account.healthError).toBeNull();

    // And nobody is told to reconnect something that is not broken.
    expect(
      await platformDb.notification.count({
        where: { organizationId: ORG, type: 'social_account.needs_reconnect' },
      }),
    ).toBe(0);
  });

  it('does not retry a validation error', async () => {
    await seedScheduled();
    mock.fault = 'VALIDATION';

    expect((await publishVariant(jobContext())).kind).toBe('FAILED');
  });

  it('leaves the account alone when the failure was about the post', async () => {
    // The half of T1.7 that matters most: a rejected caption says nothing about
    // the credential, and demoting the account would pause every other post on it.
    await seedScheduled();
    mock.fault = 'VALIDATION';

    await publishVariant(jobContext());

    const account = await platformDb.socialAccount.findUniqueOrThrow({ where: { id: ACCOUNT } });
    expect(account.status).toBe('ACTIVE');

    expect(
      await platformDb.notification.count({ where: { organizationId: ORG, resourceId: ACCOUNT } }),
    ).toBe(0);
  });

  it('defers a transient provider outage for retry', async () => {
    await seedScheduled();
    mock.fault = 'UNAVAILABLE';

    const result = await publishVariant(jobContext());

    expect(result.kind).toBe('DEFERRED');

    // Back to SCHEDULED so the retry can claim it.
    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(variant?.status).toBe('SCHEDULED');
    expect(variant?.claimToken).toBeNull();
  });

  it('refuses to publish through an account that needs reconnecting', async () => {
    await seedScheduled();
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT },
      data: { status: 'NEEDS_RECONNECT' },
    });

    try {
      await expect(publishVariant(jobContext())).rejects.toThrow();
      expect(mock.callCounts.publish).toBe(0);

      // The claim was released, so the variant is not stranded in PUBLISHING.
      const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
      expect(variant?.status).toBe('SCHEDULED');
    } finally {
      await platformDb.socialAccount.update({
        where: { id: ACCOUNT },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('never stores a raw provider message on the variant', async () => {
    await seedScheduled();
    mock.fault = 'AUTH_EXPIRED';

    await publishVariant(jobContext());

    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    // 'Mock token expired' is the internal message; only the vetted one lands.
    expect(JSON.stringify(variant?.lastError)).not.toContain('Mock token expired');
    expect(JSON.stringify(variant?.lastError)).toContain('Reconnect');
  });
});

// ── Rate limiting ───────────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('defers without consuming an attempt when the bucket is empty', async () => {
    await seedScheduled();

    // Drain the account's bucket. Mock capabilities allow 30 posts/day, capped
    // at 10 by the engine's conservative default.
    //
    // Drained at wall-clock time, not the fixed test clock: the token bucket
    // lives in Redis and is refilled from `Date.now()`, deliberately — it
    // measures real elapsed time against a provider's real quota window.
    const { rateLimitKey, takeToken } = await import('@orbit/queue');
    const key = rateLimitKey('FACEBOOK', ACCOUNT);
    for (let i = 0; i < 10; i += 1) {
      await takeToken(key, { capacity: 10, refillWindowMs: 24 * 3_600_000 }, 1, Date.now());
    }

    const result = await publishVariant(jobContext());

    expect(result.kind).toBe('DEFERRED');
    expect(result.reason).toBe('RATE_LIMIT');
    expect(mock.callCounts.publish).toBe(0);

    // No attempt was opened, so the budget is untouched.
    const attempts = await platformDb.publishingAttempt.findMany({
      where: { publishingJobId: JOB },
    });
    expect(attempts).toHaveLength(0);

    // And the variant is claimable again.
    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(variant?.status).toBe('SCHEDULED');
  });
});

// ── Partial publishing ──────────────────────────────────────────────────────

describe('multi-account publishing', () => {
  it('is PARTIALLY_PUBLISHED when one account works and another fails', async () => {
    await seedScheduled();
    await seedScheduled({ variantId: VARIANT_2, accountId: ACCOUNT_2, jobId: JOB_2 });

    await publishVariant(jobContext());

    mock.fault = 'VALIDATION';
    await publishVariant(jobContext({ variantId: VARIANT_2, jobId: JOB_2 }));

    const post = await platformDb.post.findUnique({ where: { id: POST } });
    expect(post?.status).toBe('PARTIALLY_PUBLISHED');
  });

  it('does not settle the post while a variant is still pending', async () => {
    // The bug this prevents: a post flipping to FAILED because the first of two
    // accounts errored while the other was still going.
    await seedScheduled();
    await seedScheduled({ variantId: VARIANT_2, accountId: ACCOUNT_2, jobId: JOB_2 });

    mock.fault = 'VALIDATION';
    await publishVariant(jobContext());

    // In flight, not settled: the post travels through PUBLISHING and only
    // settles once every variant has an outcome.
    const post = await platformDb.post.findUnique({ where: { id: POST } });
    expect(post?.status).toBe('PUBLISHING');
  });

  it('is PUBLISHED only when every account succeeded', async () => {
    await seedScheduled();
    await seedScheduled({ variantId: VARIANT_2, accountId: ACCOUNT_2, jobId: JOB_2 });

    await publishVariant(jobContext());
    await publishVariant(jobContext({ variantId: VARIANT_2, jobId: JOB_2 }));

    const post = await platformDb.post.findUnique({ where: { id: POST } });
    expect(post?.status).toBe('PUBLISHED');
    expect(mock.posts.size).toBe(2);
  });

  it('is FAILED when every account failed', async () => {
    await seedScheduled();
    await seedScheduled({ variantId: VARIANT_2, accountId: ACCOUNT_2, jobId: JOB_2 });

    mock.fault = 'VALIDATION';
    await publishVariant(jobContext());
    mock.fault = 'VALIDATION';
    await publishVariant(jobContext({ variantId: VARIANT_2, jobId: JOB_2 }));

    const post = await platformDb.post.findUnique({ where: { id: POST } });
    expect(post?.status).toBe('FAILED');
  });

  it('rolling up twice does not transition twice', async () => {
    await seedScheduled();
    await publishVariant(jobContext());

    const second = await rollUpPost(POST);
    expect(second.settled).toBe(false);

    const audits = await platformDb.auditLog.findMany({
      where: { organizationId: ORG, action: 'post.publish_settled' },
    });
    expect(audits).toHaveLength(1);
  });
});

// ── Tenant isolation ────────────────────────────────────────────────────────

describe('tenant derivation (decision D-021)', () => {
  it('refuses a payload naming a different tenant than the subject row', async () => {
    await seedScheduled();

    await expect(publishVariant(jobContext({ org: ORG_B }))).rejects.toThrow();

    // Nothing was claimed and nothing was published.
    expect(mock.callCounts.publish).toBe(0);
    const variant = await platformDb.postVariant.findUnique({ where: { id: VARIANT } });
    expect(variant?.status).toBe('SCHEDULED');
  });

  it('refuses a payload whose subject does not exist', async () => {
    await expect(
      publishVariant(jobContext({ variantId: '018ff100-0000-7000-8000-0000f100dead' })),
    ).rejects.toThrow();

    expect(mock.callCounts.publish).toBe(0);
  });
});
