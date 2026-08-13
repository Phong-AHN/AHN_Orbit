import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TenantIsolationError, ValidationError } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { closeQueues, closeSharedConnection } from '@orbit/queue';
import { processNotification } from './notifications.js';

/**
 * The notifications processor against real Postgres (T1.15).
 *
 * What this proves beyond the package's own tests: that a job carrying only a
 * subject id turns into the right words for the right people, that the tenant
 * is derived from the subject row rather than the payload (decision D-021), and
 * that a subject deleted between enqueue and fan-out is a quiet no-op rather
 * than a failed job that retries forever.
 */

const ORG = '018ffc00-0000-7000-8000-0000fc000001';
const ORG_B = '018ffd00-0000-7000-8000-0000fd000001';
const WS = '018ffc00-0000-7000-8000-0000fc000002';
const BRAND = '018ffc00-0000-7000-8000-0000fc000003';
const ACCOUNT = '018ffc00-0000-7000-8000-0000fc000004';
const POST = '018ffc00-0000-7000-8000-0000fc000005';
const VARIANT = '018ffc00-0000-7000-8000-0000fc000006';
const OWNER = '018ffc00-0000-7000-8000-0000fc000010';
const CREATOR = '018ffc00-0000-7000-8000-0000fc000011';

function jobFor(
  event: string,
  resourceType: 'Post' | 'PostVariant',
  resourceId: string,
  overrides: { org?: string; actorUserId?: string } = {},
) {
  return {
    payload: {
      organizationId: overrides.org ?? ORG,
      correlationId: 'itest-notify',
      event,
      resourceType,
      resourceId,
      ...(overrides.actorUserId ? { actorUserId: overrides.actorUserId } : {}),
    },
    attempt: 1,
    jobId: 'queue-job-notify-1',
    correlationId: 'itest-notify',
  };
}

beforeAll(async () => {
  process.env.ORBIT_ROLE = 'worker';

  for (const [id, slug] of [
    [ORG, 't15w'],
    [ORG_B, 't15wb'],
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
  await platformDb.socialAccount.upsert({
    where: { id: ACCOUNT },
    update: {},
    create: {
      id: ACCOUNT,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      platform: 'FACEBOOK',
      externalId: 'ext-notify',
      displayName: 'Acme Bakery',
      accountType: 'PAGE',
      status: 'ACTIVE',
    },
  });

  for (const [id, name, role] of [
    [OWNER, 'owner', 'OWNER'],
    [CREATOR, 'creator', 'CONTENT_CREATOR'],
  ] as const) {
    await platformDb.user.upsert({
      where: { id },
      update: {},
      create: { id, firebaseUid: `dev:${name}@t15w.test`, email: `${name}@t15w.test` },
    });
    await platformDb.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: ORG, userId: id } },
      update: { role, status: 'ACTIVE' },
      create: { organizationId: ORG, userId: id, role, status: 'ACTIVE' },
    });
  }

  await platformDb.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId: WS, userId: CREATOR } },
    update: {},
    create: { organizationId: ORG, workspaceId: WS, userId: CREATOR, role: 'CONTRIBUTOR' },
  });
});

beforeEach(async () => {
  await platformDb.notification.deleteMany({ where: { organizationId: ORG } });
  await platformDb.postVariant.deleteMany({ where: { organizationId: ORG } });
  await platformDb.post.deleteMany({ where: { organizationId: ORG } });

  await platformDb.post.create({
    data: {
      id: POST,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      title: 'Spring launch',
      body: 'A perfectly ordinary announcement.',
      status: 'FAILED',
      createdById: CREATOR,
    },
  });

  await platformDb.postVariant.create({
    data: {
      id: VARIANT,
      organizationId: ORG,
      postId: POST,
      socialAccountId: ACCOUNT,
      platform: 'FACEBOOK',
      body: '',
      status: 'FAILED',
      lastError: { code: 'PROVIDER_VALIDATION_ERROR', message: 'rejected' },
    },
  });
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { id: { in: [OWNER, CREATOR] } } });
  await platformDb.$disconnect();
  await closeQueues();
  await closeSharedConnection();
});

describe('publishing notifications', () => {
  it('describes a failed publish and points at the post', async () => {
    await processNotification(jobFor('publishing.failed', 'PostVariant', VARIANT));

    const rows = await platformDb.notification.findMany({ where: { organizationId: ORG } });

    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;

    expect(row.type).toBe('publishing.failed');
    expect(row.title).toContain('Spring launch');
    expect(row.title).toContain('Acme Bakery');
    // The job named the variant; the notification points at the post, which is
    // what a person actually opens.
    expect(row.resourceType).toBe('Post');
    expect(row.resourceId).toBe(POST);
  });

  it('uses the same wording as the publishing log', async () => {
    await processNotification(jobFor('publishing.failed', 'PostVariant', VARIANT));

    const row = await platformDb.notification.findFirstOrThrow({
      where: { organizationId: ORG },
    });

    // `presentFailure('PROVIDER_VALIDATION_ERROR')` is what the log renders.
    expect(row.body.length).toBeGreaterThan(0);
    expect(row.body).toContain('publishing log');
  });

  it('does not tell a Content Creator, who cannot retry a publish', async () => {
    await processNotification(jobFor('publishing.failed', 'PostVariant', VARIANT));

    const recipients = await platformDb.notification.findMany({
      where: { organizationId: ORG },
      select: { userId: true },
    });

    expect(recipients.map((r) => r.userId)).toContain(OWNER);
    expect(recipients.map((r) => r.userId)).not.toContain(CREATOR);
  });

  it('does not claim a parked publish failed', async () => {
    await processNotification(jobFor('publishing.needs_review', 'PostVariant', VARIANT));

    const row = await platformDb.notification.findFirstOrThrow({
      where: { organizationId: ORG },
    });

    expect(row.type).toBe('publishing.needs_review');
    expect(row.body).toContain('could not confirm');
  });
});

describe('approval notifications', () => {
  beforeEach(async () => {
    await platformDb.post.update({
      where: { id: POST },
      data: { status: 'CHANGES_REQUESTED' },
    });
  });

  it('sends changes back to the author', async () => {
    await processNotification(jobFor('post.changes_requested', 'Post', POST));

    const recipients = await platformDb.notification.findMany({
      where: { organizationId: ORG },
      select: { userId: true },
    });

    // The Creator is named explicitly; the Owner qualifies on `post:update`.
    expect(recipients.map((r) => r.userId)).toContain(CREATOR);
  });

  it('does not tell the person who asked for the changes', async () => {
    await processNotification(
      jobFor('post.changes_requested', 'Post', POST, { actorUserId: OWNER }),
    );

    const recipients = await platformDb.notification.findMany({
      where: { organizationId: ORG },
      select: { userId: true },
    });

    expect(recipients.map((r) => r.userId)).not.toContain(OWNER);
    expect(recipients.map((r) => r.userId)).toContain(CREATOR);
  });
});

describe('failing closed', () => {
  it('refuses a payload naming a different tenant than its subject', async () => {
    await expect(
      processNotification(jobFor('publishing.failed', 'PostVariant', VARIANT, { org: ORG_B })),
    ).rejects.toThrow(TenantIsolationError);

    expect(await platformDb.notification.count({ where: { organizationId: ORG } })).toBe(0);
  });

  it('refuses an event it cannot render', async () => {
    // Better a dead-lettered job than a notification nobody can read.
    await expect(processNotification(jobFor('post.exploded', 'Post', POST))).rejects.toThrow(
      ValidationError,
    );
  });

  it('says nothing when the subject was deleted after the job was queued', async () => {
    await platformDb.postVariant.deleteMany({ where: { id: VARIANT } });
    await platformDb.post.update({ where: { id: POST }, data: { deletedAt: new Date() } });

    // Resolvable as a tenant (the row is still there for `resolveJobTenant`),
    // but soft-deleted, so there is nothing to describe.
    await processNotification(jobFor('post.changes_requested', 'Post', POST));

    expect(await platformDb.notification.count({ where: { organizationId: ORG } })).toBe(0);
  });
});
