import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError, type TenantContext } from '@orbit/core';
import { platformDb, withTenant } from '@orbit/db';
import { listNotifications, markAllRead, markRead, unreadCount } from './read.js';
import { resolveRecipients } from './recipients.js';
import { notify } from './write.js';

/**
 * Fan-out and the inbox, against the real database (T1.15).
 *
 * The tests that matter here are the negative ones. A notification is a
 * disclosure pushed at someone, so "who was *not* told" is the property worth
 * proving: a creator outside the workspace, a client who cannot see a draft, a
 * colleague reading someone else's bell.
 */

const ORG = '018ffa00-0000-7000-8000-0000fa000001';
const ORG_B = '018ffb00-0000-7000-8000-0000fb000001';
const WS = '018ffa00-0000-7000-8000-0000fa000002';
const WS_OTHER = '018ffa00-0000-7000-8000-0000fa000003';
const BRAND = '018ffa00-0000-7000-8000-0000fa000004';
const POST = '018ffa00-0000-7000-8000-0000fa000005';

const OWNER = '018ffa00-0000-7000-8000-0000fa000010';
const APPROVER_IN = '018ffa00-0000-7000-8000-0000fa000011';
const APPROVER_OUT = '018ffa00-0000-7000-8000-0000fa000012';
const CREATOR = '018ffa00-0000-7000-8000-0000fa000013';
const CLIENT = '018ffa00-0000-7000-8000-0000fa000014';
const OUTSIDER = '018ffb00-0000-7000-8000-0000fb000010';

function contextFor(userId: string, organizationId = ORG): TenantContext {
  return {
    organizationId,
    principal: {
      kind: 'USER',
      userId,
      email: `${userId}@t15.test`,
      isPlatformAdmin: false,
      organizationRole: 'OWNER',
      membershipStatus: 'ACTIVE',
      workspaces: [],
      brands: [],
    },
    correlationId: 'itest-notifications',
  };
}

/** Only `organizationId` is read from the context by the write path. */
const orgCtx = contextFor(OWNER);

const postResource = {
  resourceType: 'Post' as const,
  resourceId: POST,
  workspaceId: WS,
  brandId: BRAND,
};

async function seedUser(
  id: string,
  name: string,
  role: string,
  workspace?: { id: string; role: 'MANAGER' | 'CONTRIBUTOR' | 'APPROVER' | 'CLIENT_VIEWER' },
) {
  await platformDb.user.upsert({
    where: { id },
    update: {},
    create: { id, firebaseUid: `dev:${name}@t15.test`, email: `${name}@t15.test` },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: ORG, userId: id } },
    update: { role: role as 'OWNER', status: 'ACTIVE' },
    create: { organizationId: ORG, userId: id, role: role as 'OWNER', status: 'ACTIVE' },
  });

  if (workspace) {
    await platformDb.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: id } },
      update: { role: workspace.role },
      create: {
        organizationId: ORG,
        workspaceId: workspace.id,
        userId: id,
        role: workspace.role,
      },
    });
  }
}

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, 't15'],
    [ORG_B, 't15b'],
  ] as const) {
    await platformDb.organization.upsert({
      where: { id },
      update: {},
      create: { id, name: slug, slug, timezone: 'UTC' },
    });
  }

  for (const [id, name] of [
    [WS, 'ws'],
    [WS_OTHER, 'other'],
  ] as const) {
    await platformDb.workspace.upsert({
      where: { id },
      update: {},
      create: { id, organizationId: ORG, name, slug: name, timezone: 'UTC' },
    });
  }

  await platformDb.brand.upsert({
    where: { id: BRAND },
    update: {},
    create: { id: BRAND, organizationId: ORG, workspaceId: WS, name: 'b', slug: 'b' },
  });

  // Owner and Admin are org-wide by definition; the rest are only where their
  // memberships put them (docs/RBAC.md §1 rule 1).
  await seedUser(OWNER, 'owner', 'OWNER');
  // `post:approve_internal` is `requiresApprovalRight`, and with no
  // BrandAssignment the workspace role has to carry it — a Contributor holding
  // the org role Approver still cannot approve here.
  await seedUser(APPROVER_IN, 'approverin', 'APPROVER', { id: WS, role: 'APPROVER' });
  await seedUser(APPROVER_OUT, 'approverout', 'APPROVER', { id: WS_OTHER, role: 'APPROVER' });
  await seedUser(CREATOR, 'creator', 'CONTENT_CREATOR', { id: WS, role: 'CONTRIBUTOR' });
  await seedUser(CLIENT, 'client', 'CLIENT', { id: WS, role: 'CLIENT_VIEWER' });

  // A member of another organization entirely.
  await platformDb.user.upsert({
    where: { id: OUTSIDER },
    update: {},
    create: { id: OUTSIDER, firebaseUid: 'dev:outsider@t15.test', email: 'outsider@t15.test' },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: ORG_B, userId: OUTSIDER } },
    update: { role: 'OWNER', status: 'ACTIVE' },
    create: { organizationId: ORG_B, userId: OUTSIDER, role: 'OWNER', status: 'ACTIVE' },
  });
});

beforeEach(async () => {
  await platformDb.notification.deleteMany({
    where: { organizationId: { in: [ORG, ORG_B] } },
  });
  await platformDb.post.deleteMany({ where: { organizationId: ORG } });

  await platformDb.post.create({
    data: {
      id: POST,
      organizationId: ORG,
      workspaceId: WS,
      brandId: BRAND,
      title: 'Spring launch',
      body: 'A perfectly ordinary announcement.',
      status: 'INTERNAL_REVIEW',
      createdById: CREATOR,
    },
  });
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG, ORG_B] } } });
  await platformDb.user.deleteMany({
    where: { id: { in: [OWNER, APPROVER_IN, APPROVER_OUT, CREATOR, CLIENT, OUTSIDER] } },
  });
  await platformDb.$disconnect();
});

// ── Fan-out ─────────────────────────────────────────────────────────────────

describe('resolving recipients', () => {
  const resolve = (type: Parameters<typeof resolveRecipients>[2], scope = {}) =>
    withTenant(orgCtx, (db) =>
      resolveRecipients(db, ORG, type, {
        workspaceId: WS,
        brandId: BRAND,
        postStatus: 'INTERNAL_REVIEW',
        createdById: CREATOR,
        ...scope,
      }),
    );

  it('tells the approvers who can see the post', async () => {
    const recipients = await resolve('post.approval_requested');

    expect(recipients).toContain(OWNER);
    expect(recipients).toContain(APPROVER_IN);
  });

  it('does not tell an approver from another workspace', async () => {
    // Holds the permission, but not here. This is the "cannot see it" half.
    const recipients = await resolve('post.approval_requested');

    expect(recipients).not.toContain(APPROVER_OUT);
  });

  it('does not tell an approver who lacks the approval right', async () => {
    // `post:approve_internal` carries `requiresApprovalRight`. Demoting the
    // workspace role to Contributor removes it, and with it the notification —
    // proof the fan-out is running the real grant rather than matching on role.
    await platformDb.workspaceMembership.update({
      where: { workspaceId_userId: { workspaceId: WS, userId: APPROVER_IN } },
      data: { role: 'CONTRIBUTOR' },
    });

    try {
      expect(await resolve('post.approval_requested')).not.toContain(APPROVER_IN);
    } finally {
      await platformDb.workspaceMembership.update({
        where: { workspaceId_userId: { workspaceId: WS, userId: APPROVER_IN } },
        data: { role: 'APPROVER' },
      });
    }
  });

  it('does not tell a client about a post that has not reached them', async () => {
    // A Client's `post:read` is restricted to CLIENT_REVIEW and later. A post
    // in INTERNAL_REVIEW is not theirs to know about.
    const recipients = await resolve('post.approval_requested');

    expect(recipients).not.toContain(CLIENT);
  });

  it('never reaches another organization’s members', async () => {
    const recipients = await resolve('post.approval_requested');

    expect(recipients).not.toContain(OUTSIDER);
  });

  it('tells whoever can retry a failed publish', async () => {
    const recipients = await resolve('publishing.failed');

    expect(recipients).toContain(OWNER);
    // An Approver approves; they do not publish, and they do not retry.
    expect(recipients).not.toContain(APPROVER_IN);
  });

  it('includes the author for changes requested, and still checks visibility', async () => {
    const withAuthor = await withTenant(orgCtx, (db) =>
      resolveRecipients(
        db,
        ORG,
        'post.changes_requested',
        {
          workspaceId: WS,
          brandId: BRAND,
          postStatus: 'CHANGES_REQUESTED',
          createdById: CREATOR,
        },
        { includeUsers: [CREATOR] },
      ),
    );

    expect(withAuthor).toContain(CREATOR);

    // The same author, named explicitly, for a post in a workspace they do not
    // belong to: being the creator is interest, never access.
    const elsewhere = await withTenant(orgCtx, (db) =>
      resolveRecipients(
        db,
        ORG,
        'post.changes_requested',
        {
          workspaceId: WS_OTHER,
          postStatus: 'CHANGES_REQUESTED',
          createdById: CREATOR,
        },
        { includeUsers: [CREATOR] },
      ),
    );

    expect(elsewhere).not.toContain(CREATOR);
  });

  it('does not tell someone about their own action', async () => {
    const recipients = await withTenant(orgCtx, (db) =>
      resolveRecipients(
        db,
        ORG,
        'post.approval_requested',
        { workspaceId: WS, brandId: BRAND, postStatus: 'INTERNAL_REVIEW' },
        { excludeUsers: [OWNER] },
      ),
    );

    expect(recipients).not.toContain(OWNER);
    expect(recipients).toContain(APPROVER_IN);
  });

  it('ignores a suspended member', async () => {
    await platformDb.organizationMembership.update({
      where: { organizationId_userId: { organizationId: ORG, userId: APPROVER_IN } },
      data: { status: 'SUSPENDED' },
    });

    try {
      expect(await resolve('post.approval_requested')).not.toContain(APPROVER_IN);
    } finally {
      await platformDb.organizationMembership.update({
        where: { organizationId_userId: { organizationId: ORG, userId: APPROVER_IN } },
        data: { status: 'ACTIVE' },
      });
    }
  });
});

// ── Writing ─────────────────────────────────────────────────────────────────

describe('writing notifications', () => {
  it('writes one in-app row per recipient', async () => {
    const result = await withTenant(orgCtx, (db) =>
      notify(db, orgCtx, {
        event: { type: 'post.approval_requested', postTitle: 'Spring launch', stage: 'INTERNAL' },
        resource: postResource,
        scope: { postStatus: 'INTERNAL_REVIEW', createdById: CREATOR },
      }),
    );

    expect(result.recipients).toBeGreaterThan(0);
    // In-app only, so rows and recipients match one for one (T1.15 scope).
    expect(result.rows).toBe(result.recipients);

    const rows = await platformDb.notification.findMany({ where: { organizationId: ORG } });
    expect(rows.every((r) => r.channel === 'IN_APP')).toBe(true);
    expect(rows.every((r) => r.readAt === null)).toBe(true);
    expect(rows[0]?.title).toContain('Spring launch');
  });

  it('writes nothing when nobody may be told', async () => {
    const result = await withTenant(orgCtx, (db) =>
      notify(db, orgCtx, {
        event: { type: 'post.approval_requested', postTitle: 'Spring launch', stage: 'INTERNAL' },
        resource: { ...postResource, workspaceId: WS_OTHER },
        scope: { postStatus: 'INTERNAL_REVIEW' },
        // The only two who would qualify for that workspace — the org-wide
        // Owner and the Approver who belongs to it — are both excluded.
        excludeUsers: [OWNER, APPROVER_OUT],
      }),
    );

    expect(result.rows).toBe(0);
    expect(await platformDb.notification.count({ where: { organizationId: ORG } })).toBe(0);
  });
});

// ── The inbox ───────────────────────────────────────────────────────────────

describe('reading your own notifications', () => {
  async function seedFor(userId: string, count: number) {
    await platformDb.notification.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        organizationId: ORG,
        userId,
        type: 'publishing.failed',
        title: `Notification ${i}`,
        body: 'body',
        resourceType: 'Post',
        resourceId: POST,
        channel: 'IN_APP' as const,
      })),
    });
  }

  it('returns only the caller’s own', async () => {
    await seedFor(OWNER, 2);
    await seedFor(APPROVER_IN, 3);

    const ctx = contextFor(OWNER);
    const page = await withTenant(ctx, (db) => listNotifications(db, ctx));

    expect(page.notifications).toHaveLength(2);
    expect(await withTenant(ctx, (db) => unreadCount(db, ctx))).toBe(2);
  });

  it('does not let one colleague read another’s, even an Owner', async () => {
    // Tenant isolation would allow this; identity is what forbids it.
    await seedFor(APPROVER_IN, 3);

    const ctx = contextFor(OWNER);
    const page = await withTenant(ctx, (db) => listNotifications(db, ctx));

    expect(page.notifications).toHaveLength(0);
  });

  it('refuses to hand an inbox to a background job', async () => {
    const systemCtx: TenantContext = {
      organizationId: ORG,
      principal: { kind: 'SYSTEM', actorName: 'test-worker', capabilities: [] },
      correlationId: 'itest',
    };

    await expect(withTenant(systemCtx, (db) => listNotifications(db, systemCtx))).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('filters to unread when asked', async () => {
    await seedFor(OWNER, 3);
    const ctx = contextFor(OWNER);

    const first = await withTenant(ctx, (db) => listNotifications(db, ctx));
    const target = first.notifications[0]!.id;

    expect(await withTenant(ctx, (db) => markRead(db, ctx, target))).toBe(true);

    const unread = await withTenant(ctx, (db) => listNotifications(db, ctx, { unreadOnly: true }));
    expect(unread.notifications).toHaveLength(2);
    expect(await withTenant(ctx, (db) => unreadCount(db, ctx))).toBe(2);
  });

  it('cannot mark someone else’s notification read', async () => {
    await seedFor(APPROVER_IN, 1);
    const [theirs] = await platformDb.notification.findMany({ where: { userId: APPROVER_IN } });

    const ctx = contextFor(OWNER);
    expect(await withTenant(ctx, (db) => markRead(db, ctx, theirs!.id))).toBe(false);

    const untouched = await platformDb.notification.findUniqueOrThrow({
      where: { id: theirs!.id },
    });
    expect(untouched.readAt).toBeNull();
  });

  it('marks everything read, and only for the caller', async () => {
    await seedFor(OWNER, 3);
    await seedFor(APPROVER_IN, 2);

    const ctx = contextFor(OWNER);
    expect(await withTenant(ctx, (db) => markAllRead(db, ctx))).toBe(3);

    const theirs = await platformDb.notification.findMany({ where: { userId: APPROVER_IN } });
    expect(theirs.every((n) => n.readAt === null)).toBe(true);
  });

  it('records when a notification was first seen, not the last refresh', async () => {
    await seedFor(OWNER, 1);
    const ctx = contextFor(OWNER);

    const [row] = await platformDb.notification.findMany({ where: { userId: OWNER } });
    expect(await withTenant(ctx, (db) => markRead(db, ctx, row!.id))).toBe(true);

    const first = await platformDb.notification.findUniqueOrThrow({ where: { id: row!.id } });

    // A second mark is a no-op rather than a fresh timestamp.
    expect(await withTenant(ctx, (db) => markRead(db, ctx, row!.id))).toBe(false);

    const second = await platformDb.notification.findUniqueOrThrow({ where: { id: row!.id } });
    expect(second.readAt).toEqual(first.readAt);
  });

  it('does not reach across tenants', async () => {
    await seedFor(OWNER, 2);

    // The same person, asking as their other organization.
    const ctx = contextFor(OWNER, ORG_B);
    const page = await withTenant(ctx, (db) => listNotifications(db, ctx));

    expect(page.notifications).toHaveLength(0);
  });
});
