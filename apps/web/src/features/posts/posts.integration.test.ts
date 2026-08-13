import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
  clock,
  type PostStatus,
  type TenantContext,
} from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection, queueFor } from '@orbit/queue';
import { s3 } from '@orbit/storage';
import { CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ensureProvidersRegistered } from '@/server/providers';
import { schedulePost } from '../scheduling/service';
import { completeMediaUpload, presignMediaUpload } from '../media/service';
import {
  assertNotSystemStatus,
  assignPost,
  createPost,
  deletePost,
  duplicatePost,
  getPost,
  listPosts,
  postScope,
  transitionPost,
  updatePost,
  updateVariant,
} from './service';
import { validatePost } from './validation';

/**
 * The post layer against the real database, real storage and the real provider
 * registry (T1.9).
 *
 * The cases that matter here are the ones a unit test cannot prove: that a post
 * id from another organization is invisible even to a caller who knows it
 * exactly, that the state machine cannot be talked past by a role, and that
 * capability validation is running against the descriptor a provider actually
 * registered rather than a fixture written to agree with the test.
 */

const ORG_A = '018f9a00-0000-7000-8000-00009a1f0001';
const ORG_B = '018f9b00-0000-7000-8000-00009b1f0001';
const WS_A = '018f9a00-0000-7000-8000-00009a1f0002';
const WS_B = '018f9b00-0000-7000-8000-00009b1f0002';
const BRAND_A = '018f9a00-0000-7000-8000-00009a1f0003';
const BRAND_A2 = '018f9a00-0000-7000-8000-00009a1f0033';
const BRAND_B = '018f9b00-0000-7000-8000-00009b1f0003';
const OWNER_A = '018f9a00-0000-7000-8000-00009a1f0004';
const OWNER_B = '018f9b00-0000-7000-8000-00009b1f0004';
const CREATOR_A = '018f9a00-0000-7000-8000-00009a1f0005';
const CLIENT_A = '018f9a00-0000-7000-8000-00009a1f0006';
const ACCOUNT_A = '018f9a00-0000-7000-8000-00009a1f0007';
const ACCOUNT_A2 = '018f9a00-0000-7000-8000-00009a1f0008';
const ACCOUNT_A_BRAND2 = '018f9a00-0000-7000-8000-00009a1f0009';
const ACCOUNT_B = '018f9b00-0000-7000-8000-00009b1f0007';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ownerA: TenantContext;
let ownerB: TenantContext;
let creatorA: TenantContext;
let clientA: TenantContext;

// ── Fixtures ────────────────────────────────────────────────────────────────

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(500)]);
}

/** presign → PUT → complete, so the asset is genuinely READY and byte-verified. */
async function uploadReadyImage(
  ctx: TenantContext,
  workspaceId: string,
  size: { width: number; height: number } = { width: 1200, height: 630 },
): Promise<string> {
  const body = png(size.width, size.height);
  const presigned = await presignMediaUpload(ctx, {
    workspaceId,
    declaredMimeType: 'image/png',
    declaredSizeBytes: body.length,
  });

  await s3().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET ?? 'orbit-media-dev',
      Key: presigned.storageKey,
      Body: body,
      ContentType: 'image/png',
    }),
  );

  const asset = await completeMediaUpload(ctx, presigned.assetId, fingerprint);
  expect(asset.status).toBe('READY');
  return asset.id;
}

async function seedOrg(org: string, ws: string, slug: string, brands: string[]) {
  await platformDb.organization.upsert({
    where: { id: org },
    update: {},
    create: { id: org, name: slug, slug, timezone: 'UTC' },
  });
  await platformDb.workspace.upsert({
    where: { id: ws },
    update: {},
    create: { id: ws, organizationId: org, name: 'ws', slug: 'main', timezone: 'UTC' },
  });
  for (const [index, brand] of brands.entries()) {
    await platformDb.brand.upsert({
      where: { id: brand },
      update: {},
      create: {
        id: brand,
        organizationId: org,
        workspaceId: ws,
        name: `brand ${index}`,
        slug: `brand-${index}`,
      },
    });
  }
}

async function seedMember(
  org: string,
  ws: string,
  userId: string,
  email: string,
  role: 'OWNER' | 'CONTENT_CREATOR' | 'CLIENT',
  workspaceRole: 'MANAGER' | 'CONTRIBUTOR' | 'CLIENT_VIEWER',
) {
  await platformDb.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, firebaseUid: `dev:${email}`, email },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId } },
    update: { role, status: 'ACTIVE' },
    create: { organizationId: org, userId, role, status: 'ACTIVE' },
  });
  await platformDb.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId: ws, userId } },
    update: { role: workspaceRole },
    create: { organizationId: org, workspaceId: ws, userId, role: workspaceRole },
  });
}

async function seedAccount(
  id: string,
  org: string,
  ws: string,
  brand: string,
  name: string,
  status: 'ACTIVE' | 'NEEDS_RECONNECT' = 'ACTIVE',
) {
  await platformDb.socialAccount.upsert({
    where: { id },
    update: { status },
    create: {
      id,
      organizationId: org,
      workspaceId: ws,
      brandId: brand,
      platform: 'FACEBOOK',
      externalId: `ext-${id.slice(-8)}`,
      displayName: name,
      handle: name.toLowerCase().replace(/\s+/g, ''),
      accountType: 'PAGE',
      status,
    },
  });
}

async function contextFor(email: string, orgId: string): Promise<TenantContext> {
  const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${email}`));
  return (await resolveTenantContext(user, orgId)).ctx;
}

/**
 * Drive a post to a status through the real machine, as an Owner.
 *
 * `Post.approvalRequired` defaults to true, so the route to APPROVED runs
 * through CLIENT_REVIEW: T1.10 made the client gate unskippable, and an
 * internal approval straight to APPROVED is refused while it applies.
 */
async function driveTo(postId: string, target: PostStatus): Promise<void> {
  const path: Record<string, PostStatus[]> = {
    INTERNAL_REVIEW: ['INTERNAL_REVIEW'],
    CLIENT_REVIEW: ['INTERNAL_REVIEW', 'CLIENT_REVIEW'],
    APPROVED: ['INTERNAL_REVIEW', 'CLIENT_REVIEW', 'APPROVED'],
    SCHEDULED: ['INTERNAL_REVIEW', 'CLIENT_REVIEW', 'APPROVED', 'SCHEDULED'],
    CHANGES_REQUESTED: ['INTERNAL_REVIEW', 'CHANGES_REQUESTED'],
  };

  for (const step of path[target] ?? [target]) {
    if (step === 'SCHEDULED') {
      // Not `transitionPost`: SCHEDULED without a date is refused, because the
      // calendar and the scheduler sweep both key off `scheduledFor`, and a row
      // without one is invisible to each of them.
      await schedulePost(
        ownerA,
        postId,
        { scheduledForUtc: new Date(clock.now().getTime() + 3_600_000).toISOString() },
        fingerprint,
      );
      continue;
    }
    await transitionPost(ownerA, postId, step, fingerprint);
  }
}

/** A post that passes validation: real account, real verified media, real text. */
async function publishablePost(ctx: TenantContext = ownerA): Promise<string> {
  const mediaAssetId = await uploadReadyImage(ctx, WS_A);
  const post = await createPost(
    ctx,
    {
      workspaceId: WS_A,
      brandId: BRAND_A,
      title: 'Ready to go',
      body: 'A perfectly ordinary announcement.',
      hashtags: ['launch'],
      mentions: [],
      media: [{ mediaAssetId }],
      socialAccountIds: [ACCOUNT_A],
    },
    fingerprint,
  );
  return post.id;
}

beforeAll(async () => {
  ensureProvidersRegistered();

  try {
    await s3().send(
      new CreateBucketCommand({ Bucket: process.env.S3_BUCKET ?? 'orbit-media-dev' }),
    );
  } catch {
    // Already there.
  }

  await seedOrg(ORG_A, WS_A, 't9a', [BRAND_A, BRAND_A2]);
  await seedOrg(ORG_B, WS_B, 't9b', [BRAND_B]);

  await seedMember(ORG_A, WS_A, OWNER_A, 'owner@t9.test', 'OWNER', 'MANAGER');
  await seedMember(ORG_A, WS_A, CREATOR_A, 'creator@t9.test', 'CONTENT_CREATOR', 'CONTRIBUTOR');
  await seedMember(ORG_A, WS_A, CLIENT_A, 'client@t9.test', 'CLIENT', 'CLIENT_VIEWER');
  await seedMember(ORG_B, WS_B, OWNER_B, 'ownerb@t9.test', 'OWNER', 'MANAGER');

  await seedAccount(ACCOUNT_A, ORG_A, WS_A, BRAND_A, 'Page A');
  await seedAccount(ACCOUNT_A2, ORG_A, WS_A, BRAND_A, 'Page A2');
  await seedAccount(ACCOUNT_A_BRAND2, ORG_A, WS_A, BRAND_A2, 'Page other brand');
  await seedAccount(ACCOUNT_B, ORG_B, WS_B, BRAND_B, 'Page B');

  ownerA = await contextFor('owner@t9.test', ORG_A);
  creatorA = await contextFor('creator@t9.test', ORG_A);
  clientA = await contextFor('client@t9.test', ORG_A);
  ownerB = await contextFor('ownerb@t9.test', ORG_B);
});

beforeEach(async () => {
  await platformDb.postMedia.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.approval.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.post.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.mediaAsset.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

/**
 * Notification jobs this file's transitions produced (T1.15).
 *
 * Read from the queue rather than mocked: the point of the assertion is that a
 * real, parseable job reaches Redis, which a spy on `enqueue` would not prove.
 */
async function queuedNotifications() {
  const jobs = await queueFor('notifications').getJobs(['waiting', 'delayed', 'prioritized']);
  return jobs
    .map((job) => job.data as { event: string; resourceId: string; organizationId: string })
    .filter((data) => data.organizationId === ORG_A);
}

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({
    where: { id: { in: [OWNER_A, OWNER_B, CREATOR_A, CLIENT_A] } },
  });
  await platformDb.$disconnect();
  // Transitions enqueue notification jobs since T1.15, so this file now holds a
  // Redis connection it has to give back.
  await closeQueues();
  await closeSharedConnection();
});

// ── Creation ────────────────────────────────────────────────────────────────

describe('creating a post', () => {
  it('creates a draft with a variant per selected account', async () => {
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        title: 'Launch day',
        body: 'Hello world',
        hashtags: ['launch'],
        mentions: [],
        media: [],
        socialAccountIds: [ACCOUNT_A, ACCOUNT_A2],
      },
      fingerprint,
    );

    expect(post.status).toBe('DRAFT');

    const full = await getPost(ownerA, post.id);
    expect(full.variants).toHaveLength(2);
    expect(full.variants.map((v) => v.socialAccountId).sort()).toEqual(
      [ACCOUNT_A, ACCOUNT_A2].sort(),
    );
  });

  it('records authorship from the session, never from the input', async () => {
    // `createPostSchema` has no `createdById` field, so the only way authorship
    // could be wrong is the service reading it from somewhere it shouldn't.
    const post = await createPost(
      creatorA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Mine',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [],
      },
      fingerprint,
    );

    expect(post.createdById).toBe(CREATOR_A);
  });

  it('refuses an account belonging to a different brand in the same tenant', async () => {
    await expect(
      createPost(
        ownerA,
        {
          workspaceId: WS_A,
          brandId: BRAND_A,
          body: 'Wrong brand',
          hashtags: [],
          mentions: [],
          media: [],
          socialAccountIds: [ACCOUNT_A_BRAND2],
        },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses an account belonging to another organization', async () => {
    await expect(
      createPost(
        ownerA,
        {
          workspaceId: WS_A,
          brandId: BRAND_A,
          body: 'Cross tenant',
          hashtags: [],
          mentions: [],
          media: [],
          socialAccountIds: [ACCOUNT_B],
        },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── Cross-tenant isolation ──────────────────────────────────────────────────

describe('cross-tenant access', () => {
  it('hides a post from another tenant even when the exact id is known', async () => {
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Private to A',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [ACCOUNT_A],
      },
      fingerprint,
    );

    // Owner B holds the highest role in their own organization and the id is
    // exact. Every path must still answer "not found".
    await expect(getPost(ownerB, post.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(postScope(ownerB, post.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(validatePost(ownerB, post.id)).resolves.toMatchObject({
      valid: false,
      variants: [],
    });
  });

  it('refuses every mutation on another tenant post', async () => {
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Private to A',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [ACCOUNT_A],
      },
      fingerprint,
    );
    const full = await getPost(ownerA, post.id);
    const variantId = full.variants[0]?.id ?? '';

    await expect(
      updatePost(ownerB, post.id, { body: 'defaced' }, fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(transitionPost(ownerB, post.id, 'CANCELED', fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    await expect(deletePost(ownerB, post.id, fingerprint)).rejects.toBeInstanceOf(NotFoundError);

    await expect(duplicatePost(ownerB, post.id, fingerprint)).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      updateVariant(ownerB, post.id, variantId, { body: 'defaced' }, fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(assignPost(ownerB, post.id, OWNER_B, fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // And the original is untouched.
    const after = await getPost(ownerA, post.id);
    expect(after.body).toBe('Private to A');
    expect(after.status).toBe('DRAFT');
  });

  it('never lists another tenant posts', async () => {
    await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'A only',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [],
      },
      fingerprint,
    );

    expect(await listPosts(ownerB)).toHaveLength(0);
  });

  it('refuses to assign a post to a user outside the organization', async () => {
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Assignment',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [],
      },
      fingerprint,
    );

    await expect(assignPost(ownerA, post.id, OWNER_B, fingerprint)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('refuses media from another tenant', async () => {
    const foreignAsset = await uploadReadyImage(ownerB, WS_B);

    await expect(
      createPost(
        ownerA,
        {
          workspaceId: WS_A,
          brandId: BRAND_A,
          body: 'Borrowed image',
          hashtags: [],
          mentions: [],
          media: [{ mediaAssetId: foreignAsset }],
          socialAccountIds: [],
        },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── Variant isolation ───────────────────────────────────────────────────────

describe('variant isolation', () => {
  it('keeps an override on the variant it was written for', async () => {
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Master text',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [ACCOUNT_A, ACCOUNT_A2],
      },
      fingerprint,
    );

    const full = await getPost(ownerA, post.id);
    const first = full.variants.find((v) => v.socialAccountId === ACCOUNT_A);
    const second = full.variants.find((v) => v.socialAccountId === ACCOUNT_A2);

    await updateVariant(ownerA, post.id, first?.id ?? '', { body: 'Just for A' }, fingerprint);

    const after = await getPost(ownerA, post.id);
    expect(after.variants.find((v) => v.id === first?.id)?.body).toBe('Just for A');
    // The sibling still inherits — an empty override means "use the master".
    expect(after.variants.find((v) => v.id === second?.id)?.body).toBe('');
    expect(after.body).toBe('Master text');
  });

  it('refuses a variant id that belongs to a different post', async () => {
    const one = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'One',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [ACCOUNT_A],
      },
      fingerprint,
    );
    const two = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Two',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [ACCOUNT_A2],
      },
      fingerprint,
    );

    const variantOfTwo = (await getPost(ownerA, two.id)).variants[0];

    await expect(
      updateVariant(ownerA, one.id, variantOfTwo?.id ?? '', { body: 'crossed' }, fingerprint),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('validates each variant against its own effective content', async () => {
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Fine everywhere',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [ACCOUNT_A, ACCOUNT_A2],
      },
      fingerprint,
    );

    const full = await getPost(ownerA, post.id);
    const target = full.variants.find((v) => v.socialAccountId === ACCOUNT_A);

    // One variant alone is pushed past the platform's text limit.
    await platformDb.postVariant.update({
      where: { id: target?.id ?? '' },
      data: { body: 'x'.repeat(70_000) },
    });

    const validation = await validatePost(ownerA, post.id);
    const failing = validation.variants.find((v) => v.variantId === target?.id);
    const passing = validation.variants.find((v) => v.variantId !== target?.id);

    expect(failing?.result.valid).toBe(false);
    expect(failing?.result.issues.some((i) => i.code === 'TEXT_TOO_LONG')).toBe(true);
    expect(passing?.result.valid).toBe(true);
    expect(validation.valid).toBe(false);
  });

  it('drops variants for deselected accounts and keeps the rest', async () => {
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Two accounts',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [ACCOUNT_A, ACCOUNT_A2],
      },
      fingerprint,
    );

    await updatePost(ownerA, post.id, { socialAccountIds: [ACCOUNT_A2] }, fingerprint);

    const after = await getPost(ownerA, post.id);
    expect(after.variants).toHaveLength(1);
    expect(after.variants[0]?.socialAccountId).toBe(ACCOUNT_A2);
  });
});

// ── State machine ───────────────────────────────────────────────────────────

describe('state transitions', () => {
  it('walks the approval path', async () => {
    const postId = await publishablePost();

    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    expect((await getPost(ownerA, postId)).status).toBe('INTERNAL_REVIEW');

    await transitionPost(ownerA, postId, 'CLIENT_REVIEW', fingerprint);
    const approved = await transitionPost(ownerA, postId, 'APPROVED', fingerprint);
    expect(approved.status).toBe('APPROVED');
  });

  it('queues a notification when a post enters review, and not otherwise (T1.15)', async () => {
    const postId = await publishablePost();

    const before = await queuedNotifications();
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);
    const afterReview = await queuedNotifications();

    // Matched by subject rather than by position: BullMQ makes no promise about
    // the order `getJobs` returns.
    const raised = afterReview.filter((job) => job.resourceId === postId);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      event: 'post.approval_requested',
      resourceId: postId,
      organizationId: ORG_A,
    });

    // Cancelling is not news anyone needs pushed at them.
    await transitionPost(ownerA, postId, 'CANCELED', fingerprint);
    const afterCancel = await queuedNotifications();
    expect(afterCancel.filter((job) => job.resourceId === postId)).toHaveLength(1);
    expect(afterCancel.length).toBe(before.length + 1);
  });

  it('refuses a transition that does not exist in the table', async () => {
    const postId = await publishablePost();

    // DRAFT → APPROVED skips review entirely. No role has this.
    await expect(transitionPost(ownerA, postId, 'APPROVED', fingerprint)).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );

    await expect(transitionPost(ownerA, postId, 'SCHEDULED', fingerprint)).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );
  });

  /**
   * The generic transition endpoint sets `status` and nothing else, so before
   * this guard a post could reach SCHEDULED with no date. It then vanished
   * twice over: the calendar filters on `scheduledFor`, and the scheduler sweep
   * looks for one that is due. The post looked scheduled and could never
   * publish.
   */
  it('refuses SCHEDULED without a date, and leaves the post where it was', async () => {
    const postId = await publishablePost();
    await driveTo(postId, 'APPROVED');

    await expect(transitionPost(ownerA, postId, 'SCHEDULED', fingerprint)).rejects.toBeInstanceOf(
      ValidationError,
    );

    // Rolled back, not left in a state it could never leave.
    const after = await getPost(ownerA, postId);
    expect(after.status).toBe('APPROVED');
    expect(after.scheduledFor).toBeNull();
  });

  it('reaches SCHEDULED with a date through the scheduling service', async () => {
    const postId = await publishablePost();
    await driveTo(postId, 'SCHEDULED');

    const after = await getPost(ownerA, postId);
    expect(after.status).toBe('SCHEDULED');
    expect(after.scheduledFor).toBeInstanceOf(Date);
  });

  it('refuses system-only statuses even for an Owner', async () => {
    const postId = await publishablePost();
    await driveTo(postId, 'SCHEDULED');

    // SCHEDULED → PUBLISHING exists, but only for a SYSTEM actor.
    await expect(transitionPost(ownerA, postId, 'PUBLISHING', fingerprint)).rejects.toBeInstanceOf(
      InvalidStateTransitionError,
    );

    for (const status of ['PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED'] as const) {
      expect(() => {
        assertNotSystemStatus(status);
      }).toThrow(ForbiddenError);
    }

    expect((await getPost(ownerA, postId)).status).toBe('SCHEDULED');
  });

  it('blocks moving forward while validation fails', async () => {
    // No accounts selected, so there is nowhere for this to publish.
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Nowhere to go',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [],
      },
      fingerprint,
    );

    await expect(
      transitionPost(ownerA, post.id, 'INTERNAL_REVIEW', fingerprint),
    ).rejects.toBeInstanceOf(ValidationError);

    expect((await getPost(ownerA, post.id)).status).toBe('DRAFT');
  });

  it('refuses an internal approval that would skip a required client gate', async () => {
    // `approvalRequired` defaults to true. The transition table allows
    // INTERNAL_REVIEW → APPROVED, but the post's own client gate does not —
    // a rule that depends on the post, so the table cannot express it.
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'INTERNAL_REVIEW', fingerprint);

    await expect(transitionPost(ownerA, postId, 'APPROVED', fingerprint)).rejects.toBeInstanceOf(
      ConflictError,
    );

    expect((await getPost(ownerA, postId)).status).toBe('INTERNAL_REVIEW');
  });

  it('allows cancelling regardless of validity', async () => {
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: '',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [],
      },
      fingerprint,
    );

    const canceled = await transitionPost(ownerA, post.id, 'CANCELED', fingerprint);
    expect(canceled.status).toBe('CANCELED');
  });

  it('locks editing once approved, and reopening voids pending approvals', async () => {
    const postId = await publishablePost();
    await driveTo(postId, 'APPROVED');

    await expect(
      updatePost(ownerA, postId, { body: 'sneaky edit' }, fingerprint),
    ).rejects.toBeInstanceOf(ConflictError);

    await platformDb.approval.create({
      data: {
        organizationId: ORG_A,
        postId,
        stage: 'INTERNAL',
        state: 'PENDING',
        requestedById: OWNER_A,
      },
    });

    await transitionPost(ownerA, postId, 'DRAFT', fingerprint);

    const approvals = await platformDb.approval.findMany({ where: { postId } });
    expect(approvals.every((a) => a.state === 'CANCELED')).toBe(true);

    // And editing works again.
    const edited = await updatePost(ownerA, postId, { body: 'now allowed' }, fingerprint);
    expect(edited.body).toBe('now allowed');
  });

  it('cancels outstanding variants when the post is cancelled', async () => {
    const postId = await publishablePost();
    await transitionPost(ownerA, postId, 'CANCELED', fingerprint);

    const variants = await platformDb.postVariant.findMany({ where: { postId } });
    expect(variants.every((v) => v.status === 'CANCELED')).toBe(true);
  });
});

// ── Authorization ───────────────────────────────────────────────────────────

describe('unauthorized mutations', () => {
  it('refuses a Client the approval a reviewer holds', async () => {
    const postId = await publishablePost();
    await driveTo(postId, 'INTERNAL_REVIEW');

    // A Client may approve at CLIENT_REVIEW, not at INTERNAL_REVIEW.
    await expect(transitionPost(clientA, postId, 'APPROVED', fingerprint)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('refuses a Content Creator the transitions reserved for approvers', async () => {
    const postId = await publishablePost();
    await driveTo(postId, 'INTERNAL_REVIEW');

    await expect(transitionPost(creatorA, postId, 'APPROVED', fingerprint)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('shows a Client only the statuses that have reached them', async () => {
    const draftId = await publishablePost();
    const sentId = await publishablePost();
    await driveTo(sentId, 'CLIENT_REVIEW');

    const { CLIENT_VISIBLE_STATUSES } = await import('@orbit/rbac');
    const visible = await listPosts(clientA, { visibleStatuses: CLIENT_VISIBLE_STATUSES });

    expect(visible.map((p) => p.id)).toContain(sentId);
    expect(visible.map((p) => p.id)).not.toContain(draftId);
  });
});

// ── Media ───────────────────────────────────────────────────────────────────

describe('media attachment', () => {
  it('attaches a verified asset', async () => {
    const mediaAssetId = await uploadReadyImage(ownerA, WS_A);

    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'With an image',
        hashtags: [],
        mentions: [],
        media: [{ mediaAssetId, altText: 'A very ordinary photograph' }],
        socialAccountIds: [ACCOUNT_A],
      },
      fingerprint,
    );

    const full = await getPost(ownerA, post.id);
    expect(full.media).toHaveLength(1);
    expect(full.media[0]?.altText).toBe('A very ordinary photograph');
    expect(full.media[0]?.mediaAsset.id).toBe(mediaAssetId);
  });

  it('refuses an asset that has not passed byte verification', async () => {
    // Presigned but never uploaded, so it is still PENDING.
    const presigned = await presignMediaUpload(ownerA, {
      workspaceId: WS_A,
      declaredMimeType: 'image/png',
      declaredSizeBytes: 1024,
    });

    await expect(
      createPost(
        ownerA,
        {
          workspaceId: WS_A,
          brandId: BRAND_A,
          body: 'Unverified',
          hashtags: [],
          mentions: [],
          media: [{ mediaAssetId: presigned.assetId }],
          socialAccountIds: [],
        },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('treats a non-READY asset as missing during validation', async () => {
    const mediaAssetId = await uploadReadyImage(ownerA, WS_A);
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Has media',
        hashtags: [],
        mentions: [],
        media: [{ mediaAssetId }],
        socialAccountIds: [ACCOUNT_A],
      },
      fingerprint,
    );

    // The asset fails a later re-check — validation must notice, not publish it.
    // The reason is not optional: a DB check constraint requires one alongside
    // REJECTED, so a rejected asset can never be left unexplained.
    await platformDb.mediaAsset.update({
      where: { id: mediaAssetId },
      data: { status: 'REJECTED', rejectionReason: 'Failed a later re-scan' },
    });

    const validation = await validatePost(ownerA, post.id);
    expect(validation.valid).toBe(false);
    expect(validation.postIssues.some((i) => i.code === 'MEDIA_NOT_READY')).toBe(true);
  });
});

// ── Platform capabilities ───────────────────────────────────────────────────

describe('platform capability validation', () => {
  it('rejects text beyond the platform limit', async () => {
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'x'.repeat(63_500),
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [ACCOUNT_A],
      },
      fingerprint,
    );

    const validation = await validatePost(ownerA, post.id);
    expect(validation.valid).toBe(false);
    expect(validation.variants[0]?.result.issues.some((i) => i.code === 'TEXT_TOO_LONG')).toBe(
      true,
    );
  });

  it('rejects more attachments than the platform accepts', async () => {
    const assets: Array<{ mediaAssetId: string }> = [];
    for (let i = 0; i < 11; i += 1) {
      assets.push({ mediaAssetId: await uploadReadyImage(ownerA, WS_A) });
    }

    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Too many pictures',
        hashtags: [],
        mentions: [],
        media: assets,
        socialAccountIds: [ACCOUNT_A],
      },
      fingerprint,
    );

    const validation = await validatePost(ownerA, post.id);
    expect(validation.valid).toBe(false);
    expect(
      validation.variants[0]?.result.issues.some((i) => i.code === 'TOO_MANY_ATTACHMENTS'),
    ).toBe(true);
  });

  it('rejects an image below the platform minimum dimensions', async () => {
    const tiny = await uploadReadyImage(ownerA, WS_A, { width: 20, height: 20 });

    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'A tiny picture',
        hashtags: [],
        mentions: [],
        media: [{ mediaAssetId: tiny }],
        socialAccountIds: [ACCOUNT_A],
      },
      fingerprint,
    );

    const validation = await validatePost(ownerA, post.id);
    const codes = validation.variants[0]?.result.issues.map((i) => i.code) ?? [];
    expect(codes.some((c) => c === 'MEDIA_TOO_NARROW' || c === 'MEDIA_TOO_SHORT')).toBe(true);
  });

  it('flags an empty post with nothing to publish', async () => {
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: '',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [ACCOUNT_A],
      },
      fingerprint,
    );

    const validation = await validatePost(ownerA, post.id);
    expect(validation.valid).toBe(false);
    expect(validation.variants[0]?.result.issues.some((i) => i.code === 'POST_EMPTY')).toBe(true);
  });

  it('flags an account that cannot publish', async () => {
    const postId = await publishablePost();

    await platformDb.socialAccount.update({
      where: { id: ACCOUNT_A },
      data: { status: 'NEEDS_RECONNECT' },
    });

    try {
      const validation = await validatePost(ownerA, postId);
      expect(validation.valid).toBe(false);
      expect(
        validation.variants[0]?.result.issues.some((i) => i.code === 'ACCOUNT_NEEDS_RECONNECT'),
      ).toBe(true);
    } finally {
      await platformDb.socialAccount.update({
        where: { id: ACCOUNT_A },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('reports no accounts selected as a post-level problem', async () => {
    const post = await createPost(
      ownerA,
      {
        workspaceId: WS_A,
        brandId: BRAND_A,
        body: 'Somewhere to go?',
        hashtags: [],
        mentions: [],
        media: [],
        socialAccountIds: [],
      },
      fingerprint,
    );

    const validation = await validatePost(ownerA, post.id);
    expect(validation.postIssues.some((i) => i.code === 'NO_ACCOUNTS_SELECTED')).toBe(true);
  });
});

// ── Duplicate and delete ────────────────────────────────────────────────────

describe('duplicate and delete', () => {
  it('duplicates content and targeting into a fresh draft', async () => {
    const postId = await publishablePost();
    await driveTo(postId, 'APPROVED');

    const copy = await duplicatePost(ownerA, postId, fingerprint);

    expect(copy.status).toBe('DRAFT');
    expect(copy.id).not.toBe(postId);

    const full = await getPost(ownerA, copy.id);
    expect(full.body).toBe('A perfectly ordinary announcement.');
    expect(full.variants).toHaveLength(1);
    expect(full.media).toHaveLength(1);
    // Publishing state is never carried over.
    expect(full.publishedAt).toBeNull();
    expect(full.variants[0]?.externalPermalink).toBeNull();
  });

  it('soft-deletes a draft and hides it everywhere', async () => {
    const postId = await publishablePost();

    await deletePost(ownerA, postId, fingerprint);

    await expect(getPost(ownerA, postId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await listPosts(ownerA)).map((p) => p.id)).not.toContain(postId);

    const row = await platformDb.post.findUnique({ where: { id: postId } });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('refuses to delete a published post', async () => {
    const postId = await publishablePost();

    // Only the worker writes this; set it directly to reach the guard. A DB
    // check constraint requires the timestamp alongside the status, so there is
    // no such thing as a PUBLISHED post that never published.
    await platformDb.post.update({
      where: { id: postId },
      data: { status: 'PUBLISHED', publishedAt: clock.now() },
    });

    await expect(deletePost(ownerA, postId, fingerprint)).rejects.toBeInstanceOf(ConflictError);
  });
});
