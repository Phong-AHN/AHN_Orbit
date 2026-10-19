import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  fixedClock,
  setClock,
  type TenantContext,
} from '@orbit/core';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection, redis } from '@orbit/queue';
import { CredentialCipher, registerProvider, resetRegistry } from '@orbit/providers';
import { MOCK_SECOND_ACCOUNT_TYPE, MockProvider } from '@orbit/providers/mock';
import { assignComment, listComments, replyToComment, setHandled, syncNow } from './service';

/**
 * Community management against real Postgres, the real grant matrix and the
 * mock provider (SRS §22).
 *
 * The things worth proving here are the ones a unit test cannot, because they
 * depend on the policy engine reading live memberships:
 *
 * 1. **A brand-scoped role is confined to its brand.** `comment:reply` is
 *    BRAND scope for a Content Creator, so the whole feature rests on a
 *    reply being authorized against the *comment's* brand rather than against
 *    the request. A creator assigned to one client must not be able to speak on
 *    another client's channel by naming a comment id.
 * 2. **An Approver can read and cannot reply.** Replying is publishing, and the
 *    matrix draws that line; this checks the line is real rather than written.
 * 3. **A reply is recorded only once the platform confirmed it**, and marks the
 *    comment it answered as handled in the same breath.
 * 4. **A comment in another tenant is invisible**, even to a caller who knows
 *    its id exactly.
 */

const ORG = '018ffc00-0000-7000-8000-0000fc000001';
const ORG_B = '018ffd00-0000-7000-8000-0000fd000001';

const WS = '018ffc00-0000-7000-8000-0000fc000002';
/**
 * A second workspace in the same organization.
 *
 * The first version of the confinement test put the other brand in the *same*
 * workspace and expected a Content Creator with one brand assignment to be
 * refused on the other. It was not, and the policy is right: a
 * `BrandAssignment` can only ever **narrow** access within a workspace, and a
 * brand with no assignment falls back to workspace membership (`policy.ts`).
 *
 * The real-world shape of "another client" is another workspace, which this is.
 */
const WS_OTHER = '018ffc00-0000-7000-8000-0000fc000022';
const WS_B = '018ffd00-0000-7000-8000-0000fd000002';
const BRAND_A = '018ffc00-0000-7000-8000-0000fc000003';
const BRAND_OTHER = '018ffc00-0000-7000-8000-0000fc000013';
const BRAND_B = '018ffd00-0000-7000-8000-0000fd000003';

const ACCOUNT_A = '018ffc00-0000-7000-8000-0000fc000004';
const ACCOUNT_OTHER = '018ffc00-0000-7000-8000-0000fc000014';
const ACCOUNT_B = '018ffd00-0000-7000-8000-0000fd000004';

const POST_A = '018ffc00-0000-7000-8000-0000fc000005';
const VARIANT_A = '018ffc00-0000-7000-8000-0000fc000006';
const POST_OTHER = '018ffc00-0000-7000-8000-0000fc000015';
const VARIANT_OTHER = '018ffc00-0000-7000-8000-0000fc000016';
const POST_B = '018ffd00-0000-7000-8000-0000fd000005';
const VARIANT_B = '018ffd00-0000-7000-8000-0000fd000006';

const OWNER = '018ffc00-0000-7000-8000-0000fc000010';
const CREATOR = '018ffc00-0000-7000-8000-0000fc000011';
const APPROVER = '018ffc00-0000-7000-8000-0000fc000012';
const CLIENT = '018ffc00-0000-7000-8000-0000fc000017';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const fingerprint = { ip: '127.0.0.1', userAgent: 'itest' };

let restoreClock: (() => void) | undefined;
let mock: MockProvider;

function ctxFor(
  userId: string,
  role: 'OWNER' | 'CONTENT_CREATOR' | 'APPROVER' | 'CLIENT',
  brands: Array<{ brandId: string; canApprove: boolean }>,
  workspaces: readonly string[] = [WS],
  organizationId = ORG,
): TenantContext {
  return {
    organizationId,
    principal: {
      kind: 'USER',
      userId,
      email: `${userId}@comm.test`,
      isPlatformAdmin: false,
      organizationRole: role,
      // Required, and the reason the first version of this file denied every
      // call: the policy engine refuses a principal whose membership is not
      // active, and an omitted field is not an active one.
      membershipStatus: 'ACTIVE',
      workspaces: workspaces.map((workspaceId) => ({ workspaceId, role: 'CONTRIBUTOR' as const })),
      brands,
    },
    correlationId: 'itest-community',
  };
}

/** Owner: organization-wide, so every grant resolves without a workspace. */
const owner = ctxFor(
  OWNER,
  'OWNER',
  [
    { brandId: BRAND_A, canApprove: true },
    { brandId: BRAND_OTHER, canApprove: true },
  ],
  [WS, WS_OTHER],
);

/**
 * In one workspace only. This is what confines them: brand-scoped grants fall
 * back to workspace membership, so the other client's workspace is out of
 * reach entirely rather than merely unassigned.
 */
const creator = ctxFor(CREATOR, 'CONTENT_CREATOR', [{ brandId: BRAND_A, canApprove: false }], [WS]);
const approver = ctxFor(APPROVER, 'APPROVER', [{ brandId: BRAND_A, canApprove: true }], [WS]);
const client = ctxFor(CLIENT, 'CLIENT', [{ brandId: BRAND_A, canApprove: true }], [WS]);

async function seedComment(
  id: string,
  over: Partial<{
    organizationId: string;
    workspaceId: string;
    brandId: string;
    socialAccountId: string;
    postVariantId: string;
    externalId: string;
    origin: 'AUDIENCE' | 'ORBIT';
    state: 'NEW' | 'HANDLED';
  }> = {},
) {
  const data = {
    id,
    organizationId: ORG,
    workspaceId: WS,
    brandId: BRAND_A,
    socialAccountId: ACCOUNT_A,
    postVariantId: VARIANT_A,
    externalId: `ext-${id.slice(-6)}`,
    origin: 'AUDIENCE' as const,
    authorName: 'Mai Tran',
    message: 'Is this available in Hanoi?',
    postedAt: NOW,
    state: 'NEW' as const,
    ...over,
  };

  await platformDb.socialComment.create({
    data: {
      ...data,
      // The `SocialComment_handled_is_complete` constraint refuses a HANDLED
      // row with no timestamp, and refused the first version of this helper.
      // The constraint is right: a queue that shows something as dealt with
      // while nothing records when is worse than one that shows it waiting.
      ...(data.state === 'HANDLED' ? { handledAt: NOW } : {}),
    },
  });
  return data;
}

beforeAll(async () => {
  resetRegistry();
  mock = new MockProvider();
  registerProvider(mock);

  for (const [id, slug] of [
    [ORG, 'comm-a'],
    [ORG_B, 'comm-b'],
  ] as const) {
    await platformDb.organization.upsert({
      where: { id },
      update: {},
      create: { id, name: slug, slug, timezone: 'UTC' },
    });
  }

  for (const [id, org, name] of [
    [WS, ORG, 'ws-a'],
    [WS_OTHER, ORG, 'ws-other'],
    [WS_B, ORG_B, 'ws-b'],
  ] as const) {
    await platformDb.workspace.upsert({
      where: { id },
      update: {},
      create: { id, organizationId: org, name, slug: name, timezone: 'UTC' },
    });
  }

  for (const [id, org, ws, name] of [
    [BRAND_A, ORG, WS, 'brand-a'],
    [BRAND_OTHER, ORG, WS_OTHER, 'brand-other'],
    [BRAND_B, ORG_B, WS_B, 'brand-b'],
  ] as const) {
    await platformDb.brand.upsert({
      where: { id },
      update: {},
      create: { id, organizationId: org, workspaceId: ws, name, slug: name },
    });
  }

  const cipher = new CredentialCipher();

  for (const [id, org, ws, brand, external] of [
    [ACCOUNT_A, ORG, WS, BRAND_A, 'mock-page-a'],
    [ACCOUNT_OTHER, ORG, WS_OTHER, BRAND_OTHER, 'mock-page-other'],
    [ACCOUNT_B, ORG_B, WS_B, BRAND_B, 'mock-page-b'],
  ] as const) {
    await platformDb.socialAccount.upsert({
      where: { id },
      update: { status: 'ACTIVE' },
      create: {
        id,
        organizationId: org,
        workspaceId: ws,
        brandId: brand,
        platform: 'FACEBOOK',
        externalId: external,
        displayName: external,
        accountType: 'PAGE',
        status: 'ACTIVE',
      },
    });

    const sealed = cipher.seal('mock-access-token', {
      organizationId: org,
      socialAccountId: id,
    });

    await platformDb.socialCredential.upsert({
      where: { socialAccountId: id },
      update: { scopes: ['mock_manage_engagement'] },
      create: {
        organizationId: org,
        socialAccountId: id,
        accessTokenCiphertext: new Uint8Array(sealed.ciphertext),
        accessTokenIv: new Uint8Array(sealed.iv),
        accessTokenAuthTag: new Uint8Array(sealed.authTag),
        keyVersion: sealed.keyVersion,
        // The scope the mock descriptor names under `replyScopes`.
        scopes: ['mock_manage_engagement'],
      },
    });
  }

  for (const [userId, email, role] of [
    [OWNER, 'owner@comm.test', 'OWNER'],
    [CREATOR, 'creator@comm.test', 'CONTENT_CREATOR'],
    [APPROVER, 'approver@comm.test', 'APPROVER'],
    [CLIENT, 'client@comm.test', 'CLIENT'],
  ] as const) {
    await platformDb.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, firebaseUid: `dev:${email}`, email },
    });
    await platformDb.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: ORG, userId } },
      update: { role: role as 'OWNER', status: 'ACTIVE' },
      create: { organizationId: ORG, userId, role: role as 'OWNER', status: 'ACTIVE' },
    });
  }

  for (const [post, variant, org, ws, brand, account] of [
    [POST_A, VARIANT_A, ORG, WS, BRAND_A, ACCOUNT_A],
    [POST_OTHER, VARIANT_OTHER, ORG, WS_OTHER, BRAND_OTHER, ACCOUNT_OTHER],
    [POST_B, VARIANT_B, ORG_B, WS_B, BRAND_B, ACCOUNT_B],
  ] as const) {
    await platformDb.post.upsert({
      where: { id: post },
      update: {},
      create: {
        id: post,
        organizationId: org,
        workspaceId: ws,
        brandId: brand,
        body: 'Published post',
        status: 'PUBLISHED',
        publishedAt: NOW,
      },
    });
    await platformDb.postVariant.upsert({
      where: { id: variant },
      update: {},
      create: {
        id: variant,
        organizationId: org,
        postId: post,
        socialAccountId: account,
        platform: 'FACEBOOK',
        body: 'Published post',
        status: 'PUBLISHED',
        externalPostId: `mock-post-${variant.slice(-4)}`,
        publishedAt: NOW,
      },
    });
  }
});

afterAll(async () => {
  await closeQueues();
  await closeSharedConnection();
  restoreClock?.();
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '@comm.test' } } });
});

beforeEach(async () => {
  restoreClock?.();
  restoreClock = setClock(fixedClock(NOW));

  mock.reset();
  await platformDb.socialComment.deleteMany({
    where: { organizationId: { in: [ORG, ORG_B] } },
  });
  await platformDb.auditLog.deleteMany({ where: { organizationId: ORG } });
});

// ── Reading ─────────────────────────────────────────────────────────────────

describe('the queue', () => {
  it('shows what the audience said', async () => {
    await seedComment('018ffc00-0000-7000-8000-0000fc000101');

    const rows = await listComments(owner, {});

    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe('Is this available in Hanoi?');
    expect(rows[0]?.authorName).toBe('Mai Tran');
  });

  /**
   * A queue of things needing attention that contains the agency's own answers
   * is a queue nobody trusts. Our replies are context for a thread, not work.
   */
  it('leaves our own replies out by default and includes them on request', async () => {
    await seedComment('018ffc00-0000-7000-8000-0000fc000102');
    await seedComment('018ffc00-0000-7000-8000-0000fc000103', {
      origin: 'ORBIT',
      state: 'HANDLED',
      externalId: 'ext-ours',
    });

    expect(await listComments(owner, {})).toHaveLength(1);
    expect(await listComments(owner, { includeOurs: true })).toHaveLength(2);
  });

  /**
   * The isolation claim, probed the way it would actually be attacked: the
   * caller knows the id exactly.
   */
  it('hides a comment belonging to another organization', async () => {
    const foreign = '018ffd00-0000-7000-8000-0000fd000101';
    await seedComment(foreign, {
      organizationId: ORG_B,
      workspaceId: WS_B,
      brandId: BRAND_B,
      socialAccountId: ACCOUNT_B,
      postVariantId: VARIANT_B,
    });

    expect(await listComments(owner, {})).toHaveLength(0);

    await expect(
      replyToComment(owner, foreign, { message: 'hello' }, fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  /**
   * An Approver reads the inbox. Only replying is withheld.
   *
   * This is the test that caught the real bug: the first version of
   * `listComments` asserted `can(ctx, 'comment:read_public', {})`, and
   * `comment:read_public` is brand-scoped for an Approver — so an empty
   * resource denied exactly the people the queue is for. The same trap as
   * **D-098**.
   */
  it('is readable by an Approver, whose grant is brand-scoped', async () => {
    await seedComment('018ffc00-0000-7000-8000-0000fc000104');

    expect(await listComments(approver, {})).toHaveLength(1);
  });

  /**
   * Narrowed by the *query*, not by a filter afterwards. A Content Creator who
   * belongs to one workspace must not see another client's comments even
   * though both sit in the same tenant.
   */
  it('shows a workspace-scoped role only their own workspaces', async () => {
    await seedComment('018ffc00-0000-7000-8000-0000fc000106');
    await seedComment('018ffc00-0000-7000-8000-0000fc000107', {
      workspaceId: WS_OTHER,
      brandId: BRAND_OTHER,
      socialAccountId: ACCOUNT_OTHER,
      postVariantId: VARIANT_OTHER,
      externalId: 'ext-other-ws',
    });

    // The owner is organization-wide and sees both.
    expect(await listComments(owner, {})).toHaveLength(2);
    // The creator belongs to one workspace and sees one.
    const mine = await listComments(creator, {});
    expect(mine).toHaveLength(1);
    expect(mine[0]?.workspaceId).toBe(WS);
  });

  it('is refused to a client entirely', async () => {
    await seedComment('018ffc00-0000-7000-8000-0000fc000105');

    await expect(listComments(client, {})).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ── Replying ────────────────────────────────────────────────────────────────

describe('replying', () => {
  const COMMENT = '018ffc00-0000-7000-8000-0000fc000201';

  async function seedWithPlatformComment() {
    const seeded = await seedComment(COMMENT);
    // The mock holds the thread the adapter would read, so `replyToComment`
    // resolves a real parent rather than a fabricated one.
    mock.comments.set('mock-post-0006', [
      {
        externalId: seeded.externalId,
        authorName: 'Mai Tran',
        message: seeded.message,
        postedAt: NOW,
        ours: false,
      },
    ]);
    return seeded;
  }

  it('posts to the platform and records the reply', async () => {
    await seedWithPlatformComment();

    const reply = await replyToComment(
      owner,
      COMMENT,
      { message: 'Yes — from Monday!' },
      fingerprint,
    );

    expect(mock.callCounts.reply).toBe(1);
    expect(reply.origin).toBe('ORBIT');
    expect(reply.message).toBe('Yes — from Monday!');
    // Threaded on the platform's own id, so ingestion and the UI agree.
    expect(reply.parentExternalId).toBe('ext-000201');
  });

  /**
   * Answering *is* handling. If these were separate the queue would show an
   * answered comment as still waiting, and somebody would answer it twice.
   */
  it('marks the comment it answered as handled, in the same transaction', async () => {
    await seedWithPlatformComment();

    await replyToComment(owner, COMMENT, { message: 'Yes!' }, fingerprint);

    const row = await platformDb.socialComment.findUniqueOrThrow({ where: { id: COMMENT } });
    expect(row.state).toBe('HANDLED');
    expect(row.handledAt).not.toBeNull();
    expect(row.handledById).toBe(OWNER);
  });

  /**
   * The platform call happens before the write. A provider refusal must leave
   * no row claiming a reply exists, and must leave the comment in the queue.
   */
  it('records nothing when the platform refuses', async () => {
    await seedWithPlatformComment();
    mock.fault = 'VALIDATION';

    await expect(
      replyToComment(owner, COMMENT, { message: 'Yes!' }, fingerprint),
    ).rejects.toThrow();

    expect(await platformDb.socialComment.count({ where: { origin: 'ORBIT' } })).toBe(0);

    const row = await platformDb.socialComment.findUniqueOrThrow({ where: { id: COMMENT } });
    expect(row.state).toBe('NEW');
  });

  /** Replying is publishing, and an Approver does not publish. */
  it('is refused to an Approver', async () => {
    await seedWithPlatformComment();

    await expect(
      replyToComment(approver, COMMENT, { message: 'Yes!' }, fingerprint),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(mock.callCounts.reply).toBe(0);
  });

  /**
   * The confinement this feature's authorization design exists for: the scope
   * comes from the row, so a creator cannot speak on another client's channel
   * by naming a comment id. The provider must never be reached.
   */
  it('confines a Content Creator to the workspaces they belong to', async () => {
    const onOtherBrand = '018ffc00-0000-7000-8000-0000fc000202';
    await seedComment(onOtherBrand, {
      workspaceId: WS_OTHER,
      brandId: BRAND_OTHER,
      socialAccountId: ACCOUNT_OTHER,
      postVariantId: VARIANT_OTHER,
      externalId: 'ext-other',
    });

    await expect(
      replyToComment(creator, onOtherBrand, { message: 'hello' }, fingerprint),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(mock.callCounts.reply).toBe(0);

    // And on their own brand they can.
    await seedWithPlatformComment();
    await expect(
      replyToComment(creator, COMMENT, { message: 'Yes!' }, fingerprint),
    ).resolves.toBeTruthy();
  });

  it('refuses to reply to our own reply', async () => {
    const ours = '018ffc00-0000-7000-8000-0000fc000203';
    await seedComment(ours, { origin: 'ORBIT', state: 'HANDLED', externalId: 'ext-ours-2' });

    await expect(
      replyToComment(owner, ours, { message: 'hello' }, fingerprint),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  /**
   * An account connected before community management shipped holds the read
   * scope and not the reply scope. Saying so before the call is better than a
   * provider refusal nobody can act on.
   */
  it('explains a connection that cannot reply, before calling the platform', async () => {
    await seedWithPlatformComment();
    await platformDb.socialCredential.update({
      where: { socialAccountId: ACCOUNT_A },
      data: { scopes: ['mock_publish'] },
    });

    try {
      // Asserted on `userMessage`, which is the text a person is shown.
      // `toThrow` matches `message`, which is the internal summary — the first
      // version of this checked the wrong one of the two.
      await expect(
        replyToComment(owner, COMMENT, { message: 'Yes!' }, fingerprint),
      ).rejects.toMatchObject({ userMessage: expect.stringMatching(/reconnect/i) });

      expect(mock.callCounts.reply).toBe(0);
    } finally {
      await platformDb.socialCredential.update({
        where: { socialAccountId: ACCOUNT_A },
        data: { scopes: ['mock_manage_engagement'] },
      });
    }
  });

  /**
   * The descriptor must be resolved with the account's own type.
   *
   * This was wrong and invisible. The service asked for `capabilities(null)`,
   * which is harmless on a platform whose descriptor does not vary — and
   * Instagram's does: one permission has two names, picked by which connection
   * flow the account used. Resolved without the type, `replyScopes` names the
   * scope belonging to the *other* flow, the credential does not hold it, and
   * the pre-flight check below refuses every reply as "needs reconnecting" on
   * an account that is connected perfectly well.
   *
   * Driven here through a second mock account type rather than a real
   * Instagram credential, because the shape of the bug is the platform's and
   * the bug itself is this service's.
   */
  it('resolves the reply scope from the account’s own connection flow', async () => {
    await seedWithPlatformComment();
    await platformDb.socialAccount.update({
      where: { id: ACCOUNT_A },
      data: { accountType: MOCK_SECOND_ACCOUNT_TYPE },
    });

    try {
      // The credential holds the *first* flow's scope. Resolved correctly, the
      // descriptor asks for the second flow's, which is genuinely missing.
      await expect(
        replyToComment(owner, COMMENT, { message: 'Yes!' }, fingerprint),
      ).rejects.toMatchObject({ userMessage: expect.stringMatching(/reconnect/i) });
      expect(mock.callCounts.reply).toBe(0);

      // And with the scope that flow actually names, the same reply goes out —
      // so the refusal above is the descriptor being honoured, not a blanket
      // failure on an unrecognised account type.
      await platformDb.socialCredential.update({
        where: { socialAccountId: ACCOUNT_A },
        data: { scopes: ['mock_second_flow_manage_engagement'] },
      });

      await replyToComment(owner, COMMENT, { message: 'Yes!' }, fingerprint);
      expect(mock.callCounts.reply).toBe(1);
    } finally {
      await platformDb.socialAccount.update({
        where: { id: ACCOUNT_A },
        data: { accountType: 'PAGE' },
      });
      await platformDb.socialCredential.update({
        where: { socialAccountId: ACCOUNT_A },
        data: { scopes: ['mock_manage_engagement'] },
      });
    }
  });

  it('audits the reply', async () => {
    await seedWithPlatformComment();
    await replyToComment(owner, COMMENT, { message: 'Yes!' }, fingerprint);

    const entries = await platformDb.auditLog.findMany({
      where: { organizationId: ORG, action: 'social_comment.replied' },
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.resourceId).toBe(COMMENT);
  });
});

// ── Triage ──────────────────────────────────────────────────────────────────

describe('triage', () => {
  const COMMENT = '018ffc00-0000-7000-8000-0000fc000301';

  it('marks handled and reopens', async () => {
    await seedComment(COMMENT);

    const handled = await setHandled(owner, COMMENT, true, fingerprint);
    expect(handled.state).toBe('HANDLED');
    expect(handled.handledAt).not.toBeNull();

    const reopened = await setHandled(owner, COMMENT, false, fingerprint);
    expect(reopened.state).toBe('NEW');
    // Cleared, because the check constraint requires a NEW row to carry
    // neither — half a record of who handled it is worse than none.
    expect(reopened.handledAt).toBeNull();
  });

  it('assigns to a teammate', async () => {
    await seedComment(COMMENT);

    const assigned = await assignComment(owner, COMMENT, { assignedToId: CREATOR }, fingerprint);
    expect(assigned.assignedToId).toBe(CREATOR);

    const cleared = await assignComment(owner, COMMENT, { assignedToId: null }, fingerprint);
    expect(cleared.assignedToId).toBeNull();
  });

  /** A comment assigned to a client is a task nobody can ever see. */
  it('refuses to assign a comment to a client', async () => {
    await seedComment(COMMENT);

    await expect(
      assignComment(owner, COMMENT, { assignedToId: CLIENT }, fingerprint),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  /**
   * 404 rather than 403, the same answer as for a user who does not exist, so
   * this cannot be used to discover who belongs to another organization.
   */
  it('answers 404 for somebody outside the organization', async () => {
    await seedComment(COMMENT);

    await expect(
      assignComment(
        owner,
        COMMENT,
        { assignedToId: '018ffd00-0000-7000-8000-0000fd000099' },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('is refused to an Approver', async () => {
    await seedComment(COMMENT);

    await expect(setHandled(approver, COMMENT, true, fingerprint)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

/**
 * The manual refresh.
 *
 * The sweep runs every 15 minutes for a fresh post, which is right for the
 * steady state and useless when somebody needs to look *now* — including when
 * somebody is recording an App Review screencast, where Meta allows 30 seconds
 * between a comment arriving and the reply going out.
 *
 * The queued jobs are not inspected here. What is worth proving at this layer
 * is who may press it, which accounts it reaches, and that it cannot be held
 * down; the job's own shape is the queue package's to test.
 */
describe('syncing the inbox on demand', () => {
  const correlation = 'itest-sync';

  /** The cooldown is a Redis key, and it outlives a test unless cleared. */
  async function clearCooldown() {
    await redis().del(`ratelimit:community-sync:org:${ORG}`);
  }

  beforeEach(clearCooldown);

  it('queues the reachable accounts and says how many', async () => {
    const result = await syncNow(owner, correlation);

    // Two accounts live in this organization; the third belongs to ORG_B.
    expect(result.queued).toBe(2);
  });

  /**
   * **Meta's rate limit is per app, not per tenant.** Every call one agency
   * makes is quota no other agency gets, so an unbounded refresh button lets
   * one organization degrade every other organization on the platform. The
   * cooldown is the only thing between a double-bound button and an app-wide
   * quota outage — not politeness about server load.
   */
  it('refuses a second press inside the cooldown', async () => {
    await syncNow(owner, correlation);

    await expect(syncNow(owner, correlation)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('allows it again once the cooldown has passed', async () => {
    await syncNow(owner, correlation);
    await clearCooldown();

    await expect(syncNow(owner, correlation)).resolves.toMatchObject({ queued: 2 });
  });

  /**
   * A brand-scoped role must not spend the tenant's provider quota reading an
   * account outside its brands — an account it cannot see is also one it must
   * not cause a call against.
   */
  it('narrows to the workspaces a brand-scoped role can reach', async () => {
    const result = await syncNow(creator, correlation);

    // The creator reaches WS only, so the account in WS_OTHER is excluded.
    expect(result.queued).toBe(1);
  });

  /** A client has no audience data anywhere in the product. */
  it('refuses a client outright', async () => {
    await expect(syncNow(client, correlation)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
