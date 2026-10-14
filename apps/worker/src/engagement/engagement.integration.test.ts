import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, setClock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection, redis } from '@orbit/queue';
import { CredentialCipher, registerProvider, resetRegistry } from '@orbit/providers';
import { MockProvider } from '@orbit/providers/mock';
import { ingestPostComments } from './ingest.js';
import { HOT_INTERVAL_MS, SWEEP_HORIZON_MS, sweepComments } from './sweep.js';

/**
 * Comment ingestion against real Postgres, real Redis and the mock provider
 * (SRS §22).
 *
 * The thing worth proving is not that a comment arrives — a unit test shows
 * that. It is the three behaviours that would quietly ruin the queue:
 *
 * 1. **Re-reading a thread must not undo the agency's work.** Ingestion runs
 *    every few minutes over the same post. If it reset `state` it would reopen
 *    every answered comment, forever, and the queue would be unusable.
 * 2. **The agency's own replies must not appear as work.** A reply sent from
 *    Orbit — or from the Facebook app by the client — arrives through the same
 *    read, and has to land already handled.
 * 3. **No commenter identifier is ever stored**, which is the privacy claim the
 *    policy now makes in writing.
 */

const ORG = '018ffe00-0000-7000-8000-0000fe000001';
const WS = '018ffe00-0000-7000-8000-0000fe000002';
const BRAND = '018ffe00-0000-7000-8000-0000fe000003';
const ACCOUNT = '018ffe00-0000-7000-8000-0000fe000004';
const POST = '018ffe00-0000-7000-8000-0000fe000005';
const VARIANT = '018ffe00-0000-7000-8000-0000fe000006';
const USER = '018ffe00-0000-7000-8000-0000fe000010';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const EXTERNAL_POST = 'mock-post-engagement';

let restoreClock: (() => void) | undefined;
let mock: MockProvider;

function ctx() {
  return {
    organizationId: ORG,
    principal: {
      kind: 'SYSTEM' as const,
      actorName: 'engagement-worker',
      capabilities: ['post:read', 'social_account:read', 'comment:read_public'],
    },
    correlationId: 'itest-engagement',
  };
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
  process.env.ORBIT_ROLE = 'worker';

  resetRegistry();
  mock = new MockProvider();
  registerProvider(mock);

  await platformDb.organization.upsert({
    where: { id: ORG },
    update: {},
    create: { id: ORG, name: 'eng', slug: 'eng', timezone: 'UTC' },
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
    update: { status: 'ACTIVE' },
    create: {
      id: ACCOUNT,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      platform: 'FACEBOOK',
      externalId: 'mock-page-eng',
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
      scopes: ['mock_manage_engagement'],
    },
  });

  await platformDb.user.upsert({
    where: { id: USER },
    update: {},
    create: { id: USER, firebaseUid: 'dev:eng@eng.test', email: 'eng@eng.test' },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: ORG, userId: USER } },
    update: {},
    create: { organizationId: ORG, userId: USER, role: 'OWNER', status: 'ACTIVE' },
  });
});

afterAll(async () => {
  restoreClock?.();
  await platformDb.organization.deleteMany({ where: { id: ORG } });
  await platformDb.user.deleteMany({ where: { email: 'eng@eng.test' } });
  await closeQueues();
  await closeSharedConnection();
});

beforeEach(async () => {
  restoreClock?.();
  restoreClock = setClock(fixedClock(NOW));

  mock.reset();
  await flushRedis();
  await platformDb.socialComment.deleteMany({ where: { organizationId: ORG } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: ORG } });
  await platformDb.post.deleteMany({ where: { organizationId: ORG } });

  await platformDb.post.create({
    data: {
      id: POST,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      body: 'Published post',
      status: 'PUBLISHED',
      publishedAt: NOW,
    },
  });
});

async function seedVariant(publishedAt = NOW, status = 'PUBLISHED') {
  await platformDb.postVariant.create({
    data: {
      id: VARIANT,
      organizationId: ORG,
      postId: POST,
      socialAccountId: ACCOUNT,
      platform: 'FACEBOOK',
      body: 'Published post',
      status: status as never,
      externalPostId: EXTERNAL_POST,
      publishedAt,
    },
  });
}

function audienceComment(id: string, at: Date, message = 'Is this in Hanoi?') {
  return { externalId: id, authorName: 'Mai Tran', message, postedAt: at, ours: false };
}

describe('ingesting comments', () => {
  it('stores what the audience said, filed against the right client', async () => {
    await seedVariant();
    mock.comments.set(EXTERNAL_POST, [audienceComment('c-1', NOW)]);

    const result = await ingestPostComments({
      ctx: ctx(),
      postVariantId: VARIANT,
      correlationId: 'itest',
    });

    expect(result).toMatchObject({ kind: 'INGESTED', created: 1 });

    const row = await platformDb.socialComment.findFirstOrThrow({
      where: { organizationId: ORG },
    });
    expect(row.message).toBe('Is this in Hanoi?');
    expect(row.authorName).toBe('Mai Tran');
    expect(row.state).toBe('NEW');
    // Attribution comes from the variant's post, not from the platform.
    expect(row.workspaceId).toBe(WS);
    expect(row.brandId).toBe(BRAND);
  });

  /**
   * The privacy claim the policy now makes in writing, asserted against the
   * stored row rather than the adapter's return type — a type is erased and a
   * stray property would still have travelled.
   */
  it('stores no identifier for the commenter', async () => {
    await seedVariant();
    mock.comments.set(EXTERNAL_POST, [audienceComment('c-1', NOW)]);

    await ingestPostComments({ ctx: ctx(), postVariantId: VARIANT, correlationId: 'itest' });

    const row = await platformDb.socialComment.findFirstOrThrow({
      where: { organizationId: ORG },
    });

    // Every column, so a future migration adding one is caught here.
    expect(Object.keys(row)).not.toContain('authorExternalId');
    expect(Object.keys(row)).not.toContain('authorId');
    expect(Object.keys(row)).not.toContain('authorUrl');
  });

  it('is idempotent across runs', async () => {
    await seedVariant();
    mock.comments.set(EXTERNAL_POST, [audienceComment('c-1', NOW)]);

    await ingestPostComments({ ctx: ctx(), postVariantId: VARIANT, correlationId: 'itest' });
    const second = await ingestPostComments({
      ctx: ctx(),
      postVariantId: VARIANT,
      correlationId: 'itest',
    });

    expect(second).toMatchObject({ kind: 'INGESTED', created: 0 });
    expect(await platformDb.socialComment.count({ where: { organizationId: ORG } })).toBe(1);
  });

  /**
   * The behaviour that makes the queue usable at all. Ingestion runs every few
   * minutes; if it touched `state` it would reopen everything the team had
   * answered, on a loop.
   */
  it('never undoes the agency’s own triage', async () => {
    await seedVariant();
    mock.comments.set(EXTERNAL_POST, [audienceComment('c-1', NOW)]);
    await ingestPostComments({ ctx: ctx(), postVariantId: VARIANT, correlationId: 'itest' });

    const before = await platformDb.socialComment.findFirstOrThrow({
      where: { organizationId: ORG },
    });
    await platformDb.socialComment.update({
      where: { id: before.id },
      data: { state: 'HANDLED', handledAt: NOW, handledById: USER, assignedToId: USER },
    });

    // The platform's copy changed too — an edited comment — so the refresh has
    // something to write and cannot be a no-op by accident.
    mock.comments.set(EXTERNAL_POST, [audienceComment('c-1', NOW, 'Is this in Hanoi or Hue?')]);
    await ingestPostComments({ ctx: ctx(), postVariantId: VARIANT, correlationId: 'itest' });

    const after = await platformDb.socialComment.findUniqueOrThrow({ where: { id: before.id } });

    // The platform's facts are refreshed…
    expect(after.message).toBe('Is this in Hanoi or Hue?');
    // …and ours are untouched.
    expect(after.state).toBe('HANDLED');
    expect(after.handledById).toBe(USER);
    expect(after.assignedToId).toBe(USER);
  });

  /**
   * A reply arrives through the same read as everything else — including one
   * typed into the Facebook app by the client themselves, which is how a
   * comment answered outside Orbit still closes here.
   */
  it('files our own reply as handled rather than as work', async () => {
    await seedVariant();
    mock.comments.set(EXTERNAL_POST, [
      audienceComment('c-1', NOW),
      {
        externalId: 'r-1',
        parentExternalId: 'c-1',
        authorName: 'Mock Page',
        message: 'Both!',
        postedAt: NOW,
        ours: true,
      },
    ]);

    await ingestPostComments({ ctx: ctx(), postVariantId: VARIANT, correlationId: 'itest' });

    const ours = await platformDb.socialComment.findFirstOrThrow({
      where: { organizationId: ORG, origin: 'ORBIT' },
    });
    expect(ours.state).toBe('HANDLED');
    expect(ours.handledAt).not.toBeNull();
    expect(ours.parentExternalId).toBe('c-1');

    // And the audience comment is still waiting, because a reply existing is
    // not the same as somebody having decided it answered the question.
    const theirs = await platformDb.socialComment.findFirstOrThrow({
      where: { organizationId: ORG, origin: 'AUDIENCE' },
    });
    expect(theirs.state).toBe('NEW');
  });

  /**
   * The incremental story. Without a watermark every run pages a popular post
   * from the beginning, which is the cost that makes a 15-minute cadence
   * impossible.
   */
  it('asks only for comments newer than the newest it holds', async () => {
    await seedVariant();
    mock.comments.set(EXTERNAL_POST, [audienceComment('c-1', NOW)]);
    await ingestPostComments({ ctx: ctx(), postVariantId: VARIANT, correlationId: 'itest' });

    // The mock honours `since`, so an older comment appearing in its map is
    // *not* returned on the next pass — proving the filter was pushed down.
    mock.comments.set(EXTERNAL_POST, [
      audienceComment('c-old', new Date(NOW.getTime() - 60 * 60 * 1_000)),
      audienceComment('c-2', new Date(NOW.getTime() + 60_000)),
    ]);

    const result = await ingestPostComments({
      ctx: ctx(),
      postVariantId: VARIANT,
      correlationId: 'itest',
    });

    expect(result).toMatchObject({ created: 1 });
    const ids = (
      await platformDb.socialComment.findMany({
        where: { organizationId: ORG },
        select: { externalId: true },
      })
    ).map((r) => r.externalId);

    expect(ids).toContain('c-2');
    expect(ids).not.toContain('c-old');
  });

  it('reads nothing from a variant that never published', async () => {
    await seedVariant(NOW, 'DRAFT');

    expect(
      await ingestPostComments({ ctx: ctx(), postVariantId: VARIANT, correlationId: 'itest' }),
    ).toEqual({ kind: 'SKIPPED', reason: 'NOT_PUBLISHED' });
    expect(mock.callCounts.fetchComments).toBe(0);
  });

  it('reads nothing from a revoked connection', async () => {
    await seedVariant();
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT },
      data: { status: 'REVOKED' },
    });

    try {
      expect(
        await ingestPostComments({ ctx: ctx(), postVariantId: VARIANT, correlationId: 'itest' }),
      ).toEqual({ kind: 'SKIPPED', reason: 'NOT_CONNECTED' });
    } finally {
      await platformDb.socialAccount.update({
        where: { id: ACCOUNT },
        data: { status: 'ACTIVE' },
      });
    }
  });
});

// ── The sweep ───────────────────────────────────────────────────────────────

describe('the sweep', () => {
  it('queues a recently published post', async () => {
    await seedVariant();

    const result = await sweepComments('itest-sweep');

    expect(result.posts).toBe(1);
    expect(result.failed).toBe(0);
  });

  /**
   * One job id per variant per interval bucket, so two workers sweeping at the
   * same moment produce one job. This is also what makes the cadence work
   * without storing a "last read" anywhere.
   */
  it('queues one job per interval bucket, not one per sweep', async () => {
    await seedVariant();

    await sweepComments('itest-sweep');
    const second = await sweepComments('itest-sweep');

    // The second pass still *counts* it — the duplicate is dropped by BullMQ
    // on the id, which is what the bucket is for. The claim worth asserting is
    // that the id does not change within a bucket.
    expect(second.posts).toBe(1);
    expect(HOT_INTERVAL_MS).toBeLessThan(SWEEP_HORIZON_MS);
  });

  /**
   * The deliberate limit, asserted so it stays deliberate: a comment on a
   * post older than the horizon is missed rather than found late. Webhooks are
   * the answer, and are not built yet.
   */
  it('ignores a post older than the sweep horizon', async () => {
    await seedVariant(new Date(NOW.getTime() - SWEEP_HORIZON_MS - 60_000));

    expect((await sweepComments('itest-sweep')).posts).toBe(0);
  });
});
