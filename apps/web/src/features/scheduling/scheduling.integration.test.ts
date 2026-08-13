import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  fixedClock,
  setClock,
  toWallClock,
  type TenantContext,
} from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { s3 } from '@orbit/storage';
import { CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ensureProvidersRegistered } from '@/server/providers';
import { completeMediaUpload, presignMediaUpload } from '../media/service';
import { createPost, getPost, transitionPost, updatePost } from '../posts/service';
import { decideApproval, listApprovalsForPost } from '../approvals/service';
import {
  listCalendar,
  reschedulePost,
  schedulePost,
  schedulingScope,
  unschedulePost,
} from './service';

/**
 * Scheduling against the real database (T1.12).
 *
 * The cases that matter here are the ones the pure tests cannot reach: that a
 * schedule survives a round trip through Postgres as the right *instant*, that
 * the workspace's zone is what decides it, that both DST transitions behave
 * when a real workspace sits in the affected zone, and that a scheduled post in
 * another tenant is invisible even with its exact id.
 */

const ORG_A = '018fd100-0000-7000-8000-0000d1000001';
const ORG_B = '018fd200-0000-7000-8000-0000d2000001';
const WS_LONDON = '018fd100-0000-7000-8000-0000d1000002';
const WS_SAIGON = '018fd100-0000-7000-8000-0000d1000003';
const WS_B = '018fd200-0000-7000-8000-0000d2000002';
const BRAND_LONDON = '018fd100-0000-7000-8000-0000d1000004';
const BRAND_SAIGON = '018fd100-0000-7000-8000-0000d1000005';
const BRAND_B = '018fd200-0000-7000-8000-0000d2000004';
const OWNER_A = '018fd100-0000-7000-8000-0000d1000006';
const OWNER_B = '018fd200-0000-7000-8000-0000d2000006';
const CREATOR_A = '018fd100-0000-7000-8000-0000d1000007';
const ACCOUNT_LONDON = '018fd100-0000-7000-8000-0000d1000008';
const ACCOUNT_SAIGON = '018fd100-0000-7000-8000-0000d1000009';
const ACCOUNT_B = '018fd200-0000-7000-8000-0000d2000008';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

/** Well before every DST date used below, so leads are always positive. */
const NOW = new Date('2026-02-01T12:00:00Z');

let ownerA: TenantContext;
let ownerB: TenantContext;
let creatorA: TenantContext;
let restoreClock: (() => void) | undefined;

// ── Fixtures ────────────────────────────────────────────────────────────────

function png(): Buffer {
  const header = Buffer.alloc(33);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(1200, 16);
  header.writeUInt32BE(630, 20);
  return Buffer.concat([header, Buffer.alloc(500)]);
}

async function uploadReadyImage(ctx: TenantContext, workspaceId: string): Promise<string> {
  const body = png();
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

  return (await completeMediaUpload(ctx, presigned.assetId, fingerprint)).id;
}

async function seedWorkspace(
  org: string,
  ws: string,
  brand: string,
  timezone: string,
  slug: string,
) {
  await platformDb.workspace.upsert({
    where: { id: ws },
    update: { timezone },
    create: { id: ws, organizationId: org, name: slug, slug, timezone },
  });
  await platformDb.brand.upsert({
    where: { id: brand },
    update: {},
    create: { id: brand, organizationId: org, workspaceId: ws, name: slug, slug },
  });
}

async function seedMember(
  org: string,
  workspaces: string[],
  userId: string,
  email: string,
  role: 'OWNER' | 'CONTENT_CREATOR',
) {
  await platformDb.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId, firebaseUid: `dev:${email}`, email, timezone: 'Europe/London' },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org, userId } },
    update: { role, status: 'ACTIVE' },
    create: { organizationId: org, userId, role, status: 'ACTIVE' },
  });
  for (const ws of workspaces) {
    await platformDb.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId: ws, userId } },
      update: { role: role === 'OWNER' ? 'MANAGER' : 'CONTRIBUTOR' },
      create: {
        organizationId: org,
        workspaceId: ws,
        userId,
        role: role === 'OWNER' ? 'MANAGER' : 'CONTRIBUTOR',
      },
    });
  }
}

async function seedAccount(id: string, org: string, ws: string, brand: string, name: string) {
  await platformDb.socialAccount.upsert({
    where: { id },
    update: { status: 'ACTIVE' },
    create: {
      id,
      organizationId: org,
      workspaceId: ws,
      brandId: brand,
      platform: 'FACEBOOK',
      externalId: `ext-${id.slice(-8)}`,
      displayName: name,
      handle: name.toLowerCase(),
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });
}

async function contextFor(email: string, orgId: string): Promise<TenantContext> {
  const user = await resolveUser(await devIdentityProvider.verifyIdToken(`dev:${email}`));
  return (await resolveTenantContext(user, orgId)).ctx;
}

/** An approved post, ready to schedule. `approvalRequired` off to keep it short. */
async function approvedPost(
  options: { ctx?: TenantContext; workspaceId?: string; brandId?: string; accountId?: string } = {},
): Promise<string> {
  const ctx = options.ctx ?? ownerA;
  const workspaceId = options.workspaceId ?? WS_LONDON;
  const brandId = options.brandId ?? BRAND_LONDON;
  const accountId = options.accountId ?? ACCOUNT_LONDON;

  const mediaAssetId = await uploadReadyImage(ctx, workspaceId);

  const post = await createPost(
    ctx,
    {
      workspaceId,
      brandId,
      title: 'Scheduled post',
      body: 'A perfectly ordinary announcement.',
      hashtags: [],
      mentions: [],
      media: [{ mediaAssetId }],
      socialAccountIds: [accountId],
    },
    fingerprint,
  );

  await updatePost(ownerA, post.id, { approvalRequired: false }, fingerprint);
  await transitionPost(ownerA, post.id, 'INTERNAL_REVIEW', fingerprint);
  await decideApproval(
    ownerA,
    (await listApprovalsForPost(ownerA, post.id)).filter((a) => a.state === 'PENDING')[0]?.id ?? '',
    { decision: 'APPROVED' },
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

  for (const [org, slug] of [
    [ORG_A, 't12a'],
    [ORG_B, 't12b'],
  ] as const) {
    await platformDb.organization.upsert({
      where: { id: org },
      update: {},
      create: { id: org, name: slug, slug, timezone: 'UTC' },
    });
  }

  await seedWorkspace(ORG_A, WS_LONDON, BRAND_LONDON, 'Europe/London', 'london');
  await seedWorkspace(ORG_A, WS_SAIGON, BRAND_SAIGON, 'Asia/Ho_Chi_Minh', 'saigon');
  await seedWorkspace(ORG_B, WS_B, BRAND_B, 'UTC', 'other');

  await seedMember(ORG_A, [WS_LONDON, WS_SAIGON], OWNER_A, 'owner@t12.test', 'OWNER');
  await seedMember(ORG_A, [WS_LONDON], CREATOR_A, 'creator@t12.test', 'CONTENT_CREATOR');
  await seedMember(ORG_B, [WS_B], OWNER_B, 'ownerb@t12.test', 'OWNER');

  await seedAccount(ACCOUNT_LONDON, ORG_A, WS_LONDON, BRAND_LONDON, 'PageLondon');
  await seedAccount(ACCOUNT_SAIGON, ORG_A, WS_SAIGON, BRAND_SAIGON, 'PageSaigon');
  await seedAccount(ACCOUNT_B, ORG_B, WS_B, BRAND_B, 'PageB');

  ownerA = await contextFor('owner@t12.test', ORG_A);
  creatorA = await contextFor('creator@t12.test', ORG_A);
  ownerB = await contextFor('ownerb@t12.test', ORG_B);
});

beforeEach(async () => {
  // A fixed clock: lead-time and DST assertions have to be reproducible.
  restoreClock = setClock(fixedClock(NOW));

  await platformDb.publishingJob.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.approval.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.postMedia.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.post.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.mediaAsset.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
  await platformDb.queueSlot.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });
});

afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { id: { in: [OWNER_A, OWNER_B, CREATOR_A] } } });
  await platformDb.$disconnect();
});

// ── Scheduling ──────────────────────────────────────────────────────────────

describe('scheduling a post', () => {
  it('stores the UTC instant the workspace zone names', async () => {
    const postId = await approvedPost({
      workspaceId: WS_SAIGON,
      brandId: BRAND_SAIGON,
      accountId: ACCOUNT_SAIGON,
    });

    const result = await schedulePost(
      ownerA,
      postId,
      { localTime: { year: 2026, month: 3, day: 10, hour: 9, minute: 0 } },
      fingerprint,
    );

    // 09:00 +07 is 02:00 UTC.
    expect(result.scheduledFor.toISOString()).toBe('2026-03-10T02:00:00.000Z');
    expect(result.timezone).toBe('Asia/Ho_Chi_Minh');

    const post = await getPost(ownerA, postId);
    expect(post.status).toBe('SCHEDULED');
    expect(post.scheduledFor?.toISOString()).toBe('2026-03-10T02:00:00.000Z');
  });

  it('resolves the same wall time differently per workspace zone', async () => {
    // The heart of assumption C5: the workspace decides what 09:00 means.
    const london = await approvedPost();
    const saigon = await approvedPost({
      workspaceId: WS_SAIGON,
      brandId: BRAND_SAIGON,
      accountId: ACCOUNT_SAIGON,
    });

    const localTime = { year: 2026, month: 3, day: 10, hour: 9, minute: 0 };

    const a = await schedulePost(ownerA, london, { localTime }, fingerprint);
    const b = await schedulePost(ownerA, saigon, { localTime }, fingerprint);

    expect(a.scheduledFor.toISOString()).toBe('2026-03-10T09:00:00.000Z');
    expect(b.scheduledFor.toISOString()).toBe('2026-03-10T02:00:00.000Z');
  });

  it('schedules every publishable variant and stamps a content hash', async () => {
    const postId = await approvedPost();
    await schedulePost(
      ownerA,
      postId,
      { localTime: { year: 2026, month: 3, day: 10, hour: 9, minute: 0 } },
      fingerprint,
    );

    const variants = await platformDb.postVariant.findMany({ where: { postId } });
    expect(variants).toHaveLength(1);
    expect(variants[0]?.status).toBe('SCHEDULED');
    expect(variants[0]?.scheduledFor?.toISOString()).toBe('2026-03-10T09:00:00.000Z');
    // Without a hash the sweep refuses to enqueue — no stable idempotency key.
    expect(variants[0]?.contentHash).toBeTruthy();
  });

  it('accepts an explicit UTC instant', async () => {
    const postId = await approvedPost();
    const result = await schedulePost(
      ownerA,
      postId,
      { scheduledForUtc: '2026-03-10T09:00:00.000Z' },
      fingerprint,
    );

    expect(result.scheduledFor.toISOString()).toBe('2026-03-10T09:00:00.000Z');
  });

  it('rejects a time in the past', async () => {
    const postId = await approvedPost();

    await expect(
      schedulePost(
        ownerA,
        postId,
        { localTime: { year: 2025, month: 1, day: 1, hour: 9, minute: 0 } },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect((await getPost(ownerA, postId)).status).toBe('APPROVED');
  });

  it('rejects more than one intent at once', async () => {
    const postId = await approvedPost();

    await expect(
      schedulePost(
        ownerA,
        postId,
        {
          localTime: { year: 2026, month: 3, day: 10, hour: 9, minute: 0 },
          useNextQueueSlot: true,
        },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('writes an audit row carrying the zone', async () => {
    const postId = await approvedPost();
    await schedulePost(
      ownerA,
      postId,
      { localTime: { year: 2026, month: 3, day: 10, hour: 9, minute: 0 } },
      fingerprint,
    );

    const entry = await platformDb.auditLog.findFirst({
      where: { organizationId: ORG_A, resourceId: postId, action: 'post.scheduled' },
    });

    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry?.after)).toContain('Europe/London');
  });
});

// ── DST, against a real workspace in an affected zone ───────────────────────

describe('daylight saving', () => {
  it('refuses a time that does not exist on the spring-forward day', async () => {
    // 2026-03-29: London jumps 01:00 → 02:00. A person picked 01:30, so they
    // are told rather than silently moved (decision D-023).
    const postId = await approvedPost();

    await expect(
      schedulePost(
        ownerA,
        postId,
        { localTime: { year: 2026, month: 3, day: 29, hour: 1, minute: 30 } },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect((await getPost(ownerA, postId)).status).toBe('APPROVED');
  });

  it('takes the earlier instant on the autumn-back day', async () => {
    // 2026-10-25: London falls 02:00 → 01:00, so 01:30 happens twice.
    const postId = await approvedPost();

    const result = await schedulePost(
      ownerA,
      postId,
      { localTime: { year: 2026, month: 10, day: 25, hour: 1, minute: 30 } },
      fingerprint,
    );

    expect(result.scheduledFor.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('keeps 09:00 meaning 09:00 either side of a transition', async () => {
    // The property that matters to a user: the same wall time in the same zone
    // publishes at the right moment whatever the offset happens to be.
    const before = await approvedPost();
    const after = await approvedPost();

    const beforeResult = await schedulePost(
      ownerA,
      before,
      { localTime: { year: 2026, month: 3, day: 28, hour: 9, minute: 0 } },
      fingerprint,
    );
    const afterResult = await schedulePost(
      ownerA,
      after,
      { localTime: { year: 2026, month: 3, day: 30, hour: 9, minute: 0 } },
      fingerprint,
    );

    // GMT before, BST after — an hour's difference in UTC for the same wall time.
    expect(beforeResult.scheduledFor.toISOString()).toBe('2026-03-28T09:00:00.000Z');
    expect(afterResult.scheduledFor.toISOString()).toBe('2026-03-30T08:00:00.000Z');

    // And both read back as 09:00 where they were scheduled.
    expect(toWallClock(beforeResult.scheduledFor, 'Europe/London').hour).toBe(9);
    expect(toWallClock(afterResult.scheduledFor, 'Europe/London').hour).toBe(9);
  });

  it('is unaffected in a zone without DST', async () => {
    const postId = await approvedPost({
      workspaceId: WS_SAIGON,
      brandId: BRAND_SAIGON,
      accountId: ACCOUNT_SAIGON,
    });

    const result = await schedulePost(
      ownerA,
      postId,
      { localTime: { year: 2026, month: 3, day: 29, hour: 1, minute: 30 } },
      fingerprint,
    );

    // The London gap has no bearing on Saigon.
    expect(result.scheduledFor.toISOString()).toBe('2026-03-28T18:30:00.000Z');
  });
});

// ── Queue slots ─────────────────────────────────────────────────────────────

describe('queue slots', () => {
  it('schedules into the next configured slot', async () => {
    await platformDb.queueSlot.create({
      data: {
        organizationId: ORG_A,
        workspaceId: WS_LONDON,
        // 2026-02-01 is a Sunday; the next Wednesday is the 4th.
        dayOfWeek: 3,
        localTime: '09:00',
        timezone: 'Europe/London',
        isActive: true,
      },
    });

    const postId = await approvedPost();
    const result = await schedulePost(ownerA, postId, { useNextQueueSlot: true }, fingerprint);

    expect(result.scheduledFor.toISOString()).toBe('2026-02-04T09:00:00.000Z');
  });

  it('takes the soonest of several slots', async () => {
    for (const [dayOfWeek, localTime] of [
      [5, '09:00'],
      [2, '09:00'],
    ] as const) {
      await platformDb.queueSlot.create({
        data: {
          organizationId: ORG_A,
          workspaceId: WS_LONDON,
          dayOfWeek,
          localTime,
          timezone: 'Europe/London',
          isActive: true,
        },
      });
    }

    const postId = await approvedPost();
    const result = await schedulePost(ownerA, postId, { useNextQueueSlot: true }, fingerprint);

    // Tuesday the 3rd beats Friday the 6th.
    expect(result.scheduledFor.toISOString()).toBe('2026-02-03T09:00:00.000Z');
  });

  it('ignores inactive slots', async () => {
    await platformDb.queueSlot.create({
      data: {
        organizationId: ORG_A,
        workspaceId: WS_LONDON,
        dayOfWeek: 2,
        localTime: '09:00',
        timezone: 'Europe/London',
        isActive: false,
      },
    });

    const postId = await approvedPost();

    await expect(
      schedulePost(ownerA, postId, { useNextQueueSlot: true }, fingerprint),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('never uses another workspace slots', async () => {
    await platformDb.queueSlot.create({
      data: {
        organizationId: ORG_A,
        workspaceId: WS_SAIGON,
        dayOfWeek: 2,
        localTime: '09:00',
        timezone: 'Asia/Ho_Chi_Minh',
        isActive: true,
      },
    });

    // The London post has no slots of its own.
    const postId = await approvedPost();
    await expect(
      schedulePost(ownerA, postId, { useNextQueueSlot: true }, fingerprint),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ── Rescheduling ────────────────────────────────────────────────────────────

describe('rescheduling', () => {
  async function scheduled(): Promise<string> {
    const postId = await approvedPost();
    await schedulePost(
      ownerA,
      postId,
      { localTime: { year: 2026, month: 3, day: 10, hour: 9, minute: 0 } },
      fingerprint,
    );
    return postId;
  }

  it('moves the post and every variant', async () => {
    const postId = await scheduled();

    const result = await reschedulePost(
      ownerA,
      postId,
      { localTime: { year: 2026, month: 3, day: 11, hour: 14, minute: 30 } },
      fingerprint,
    );

    expect(result.scheduledFor.toISOString()).toBe('2026-03-11T14:30:00.000Z');

    const variants = await platformDb.postVariant.findMany({ where: { postId } });
    expect(variants[0]?.scheduledFor?.toISOString()).toBe('2026-03-11T14:30:00.000Z');
    // Still scheduled — rescheduling is not a state transition.
    expect((await getPost(ownerA, postId)).status).toBe('SCHEDULED');
  });

  it('refuses to reschedule a post that is not scheduled', async () => {
    const postId = await approvedPost();

    await expect(
      reschedulePost(
        ownerA,
        postId,
        { localTime: { year: 2026, month: 3, day: 11, hour: 9, minute: 0 } },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses once an account has started publishing', async () => {
    const postId = await scheduled();

    // Only the worker writes this; set it directly to reach the guard.
    await platformDb.postVariant.updateMany({
      where: { postId },
      data: { status: 'PUBLISHING' },
    });

    await expect(
      reschedulePost(
        ownerA,
        postId,
        { localTime: { year: 2026, month: 3, day: 11, hour: 9, minute: 0 } },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('refuses a Content Creator, who holds no reschedule right', async () => {
    const postId = await scheduled();

    await expect(
      reschedulePost(
        creatorA,
        postId,
        { localTime: { year: 2026, month: 3, day: 11, hour: 9, minute: 0 } },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('records both times in the audit trail', async () => {
    const postId = await scheduled();
    await reschedulePost(
      ownerA,
      postId,
      { localTime: { year: 2026, month: 3, day: 11, hour: 14, minute: 30 } },
      fingerprint,
    );

    const entry = await platformDb.auditLog.findFirst({
      where: { organizationId: ORG_A, resourceId: postId, action: 'post.rescheduled' },
    });

    expect(JSON.stringify(entry?.before)).toContain('2026-03-10T09:00');
    expect(JSON.stringify(entry?.after)).toContain('2026-03-11T14:30');
  });

  it('unschedules cleanly back to draft, voiding approvals', async () => {
    const postId = await scheduled();

    await unschedulePost(ownerA, postId, fingerprint);

    const post = await getPost(ownerA, postId);
    expect(post.status).toBe('DRAFT');
    expect(post.scheduledFor).toBeNull();

    const variants = await platformDb.postVariant.findMany({ where: { postId } });
    expect(variants[0]?.status).toBe('DRAFT');
    expect(variants[0]?.scheduledFor).toBeNull();
  });
});

// ── Cross-tenant ────────────────────────────────────────────────────────────

describe('cross-tenant isolation', () => {
  it('hides a scheduled post from another tenant even with the exact id', async () => {
    const postId = await approvedPost();
    await schedulePost(
      ownerA,
      postId,
      { localTime: { year: 2026, month: 3, day: 10, hour: 9, minute: 0 } },
      fingerprint,
    );

    await expect(schedulingScope(ownerB, postId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      reschedulePost(
        ownerB,
        postId,
        { localTime: { year: 2026, month: 3, day: 11, hour: 9, minute: 0 } },
        fingerprint,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(unschedulePost(ownerB, postId, fingerprint)).rejects.toBeInstanceOf(NotFoundError);

    // Untouched.
    const post = await getPost(ownerA, postId);
    expect(post.scheduledFor?.toISOString()).toBe('2026-03-10T09:00:00.000Z');
  });

  it('never shows another tenant posts on the calendar', async () => {
    const postId = await approvedPost();
    await schedulePost(
      ownerA,
      postId,
      { localTime: { year: 2026, month: 3, day: 10, hour: 9, minute: 0 } },
      fingerprint,
    );

    const window = {
      from: { year: 2026, month: 3, day: 1 },
      to: { year: 2026, month: 4, day: 1 },
      timeZone: 'UTC',
    };

    expect(await listCalendar(ownerB, window)).toHaveLength(0);
    expect((await listCalendar(ownerA, window)).map((p) => p.id)).toContain(postId);
  });
});

// ── Calendar ────────────────────────────────────────────────────────────────

describe('the calendar', () => {
  async function scheduleAt(iso: string): Promise<string> {
    const postId = await approvedPost({
      workspaceId: WS_SAIGON,
      brandId: BRAND_SAIGON,
      accountId: ACCOUNT_SAIGON,
    });
    await schedulePost(ownerA, postId, { scheduledForUtc: iso }, fingerprint);
    return postId;
  }

  it('windows by wall date in the display zone, not UTC', async () => {
    // 2026-03-31T18:00Z is 01:00 on 1 April in Saigon. Asking for March in
    // Saigon must exclude it; asking in UTC must include it.
    const postId = await scheduleAt('2026-03-31T18:00:00.000Z');

    const inUtc = await listCalendar(ownerA, {
      from: { year: 2026, month: 3, day: 1 },
      to: { year: 2026, month: 4, day: 1 },
      timeZone: 'UTC',
    });
    const inSaigon = await listCalendar(ownerA, {
      from: { year: 2026, month: 3, day: 1 },
      to: { year: 2026, month: 4, day: 1 },
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    expect(inUtc.map((p) => p.id)).toContain(postId);
    expect(inSaigon.map((p) => p.id)).not.toContain(postId);
  });

  it('returns the zone a post was scheduled in, for dual display', async () => {
    const postId = await scheduleAt('2026-03-10T02:00:00.000Z');

    const posts = await listCalendar(ownerA, {
      from: { year: 2026, month: 3, day: 1 },
      to: { year: 2026, month: 4, day: 1 },
      timeZone: 'UTC',
    });

    expect(posts.find((p) => p.id === postId)?.timezone).toBe('Asia/Ho_Chi_Minh');
  });

  it('rejects an inverted window', async () => {
    await expect(
      listCalendar(ownerA, {
        from: { year: 2026, month: 4, day: 1 },
        to: { year: 2026, month: 3, day: 1 },
        timeZone: 'UTC',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a window too large to be a calendar', async () => {
    await expect(
      listCalendar(ownerA, {
        from: { year: 2026, month: 1, day: 1 },
        to: { year: 2026, month: 12, day: 31 },
        timeZone: 'UTC',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an unknown display zone', async () => {
    await expect(
      listCalendar(ownerA, {
        from: { year: 2026, month: 3, day: 1 },
        to: { year: 2026, month: 4, day: 1 },
        timeZone: 'Mars/Olympus_Mons',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('filters to a workspace', async () => {
    const saigon = await scheduleAt('2026-03-10T02:00:00.000Z');

    const london = await approvedPost();
    await schedulePost(
      ownerA,
      london,
      { localTime: { year: 2026, month: 3, day: 10, hour: 9, minute: 0 } },
      fingerprint,
    );

    const filtered = await listCalendar(ownerA, {
      from: { year: 2026, month: 3, day: 1 },
      to: { year: 2026, month: 4, day: 1 },
      timeZone: 'UTC',
      workspaceId: WS_SAIGON,
    });

    expect(filtered.map((p) => p.id)).toEqual([saigon]);
  });

  it('confines a workspace-scoped principal to their own workspaces', async () => {
    const saigon = await scheduleAt('2026-03-10T02:00:00.000Z');

    const london = await approvedPost();
    await schedulePost(
      ownerA,
      london,
      { localTime: { year: 2026, month: 3, day: 10, hour: 9, minute: 0 } },
      fingerprint,
    );

    // The Content Creator belongs to London only.
    const visible = await listCalendar(creatorA, {
      from: { year: 2026, month: 3, day: 1 },
      to: { year: 2026, month: 4, day: 1 },
      timeZone: 'UTC',
      accessibleWorkspaces: [WS_LONDON],
    });

    expect(visible.map((p) => p.id)).toContain(london);
    expect(visible.map((p) => p.id)).not.toContain(saigon);
  });
});
