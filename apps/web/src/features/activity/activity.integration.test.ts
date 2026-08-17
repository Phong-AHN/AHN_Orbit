import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantContext } from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { listActivity } from './service';

/**
 * The activity feed against the real database.
 *
 * Two things need proving and neither can be proven by a unit test: that
 * another organization's history is invisible even though the feed is
 * deliberately broad, and that a workspace-scoped reader is narrowed to their
 * own workspaces — including that organization-level rows, which belong to the
 * agency rather than to any workspace, stay out.
 */

const ORG_A = '018fd300-0000-7000-8000-0000d3000001';
const ORG_B = '018fd400-0000-7000-8000-0000d4000001';
const WS_A1 = '018fd300-0000-7000-8000-0000d3000002';
const WS_A2 = '018fd300-0000-7000-8000-0000d3000003';
const WS_B = '018fd400-0000-7000-8000-0000d4000002';

let ownerA: TenantContext;
let managerA: TenantContext;

async function org(id: string, slug: string, workspaces: string[]) {
  await platformDb.organization.upsert({
    where: { id },
    update: {},
    create: { id, name: slug, slug, timezone: 'UTC' },
  });

  for (const [index, ws] of workspaces.entries()) {
    await platformDb.workspace.upsert({
      where: { id: ws },
      update: {},
      create: {
        id: ws,
        organizationId: id,
        name: `${slug}-${index}`,
        slug: `${slug}-${index}`,
        timezone: 'UTC',
      },
    });
  }
}

async function member(
  orgId: string,
  email: string,
  role: 'OWNER' | 'ACCOUNT_MANAGER',
  workspaceIds: string[],
) {
  const identity = await devIdentityProvider.verifyIdToken(`dev:${email}`);
  const user = await resolveUser(identity);

  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: orgId, userId: user.id } },
    update: { role },
    create: { organizationId: orgId, userId: user.id, role, status: 'ACTIVE' },
  });

  for (const workspaceId of workspaceIds) {
    await platformDb.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      update: {},
      create: { organizationId: orgId, workspaceId, userId: user.id, role: 'MANAGER' },
    });
  }

  const { ctx } = await resolveTenantContext(user, orgId, 'itest-activity');
  return ctx;
}

beforeAll(async () => {
  await org(ORG_A, 'act-a', [WS_A1, WS_A2]);
  await org(ORG_B, 'act-b', [WS_B]);

  ownerA = await member(ORG_A, 'owner@act-a.test', 'OWNER', []);
  managerA = await member(ORG_A, 'manager@act-a.test', 'ACCOUNT_MANAGER', [WS_A1]);
  await member(ORG_B, 'owner@act-b.test', 'OWNER', []);
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { email: { endsWith: '.test' } } });
});

beforeEach(async () => {
  await platformDb.auditLog.deleteMany({ where: { organizationId: { in: [ORG_A, ORG_B] } } });

  await platformDb.auditLog.createMany({
    data: [
      {
        organizationId: ORG_A,
        workspaceId: WS_A1,
        action: 'post.created',
        resourceType: 'Post',
        actorType: 'USER',
      },
      {
        organizationId: ORG_A,
        workspaceId: WS_A2,
        action: 'post.created',
        resourceType: 'Post',
        actorType: 'USER',
      },
      {
        // Organization-level: belongs to the agency, not to any workspace.
        organizationId: ORG_A,
        action: 'member.role_changed',
        resourceType: 'OrganizationMembership',
        actorType: 'USER',
      },
      {
        organizationId: ORG_B,
        workspaceId: WS_B,
        action: 'post.created',
        resourceType: 'Post',
        actorType: 'USER',
      },
    ],
  });
});

describe('listActivity', () => {
  it('shows an owner everything in their organization and nothing from another', async () => {
    const { entries } = await listActivity(ownerA);

    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.action !== undefined)).toBe(true);
  });

  it('narrows a workspace-scoped reader to their own workspaces', async () => {
    const { entries } = await listActivity(managerA);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.workspaceId).toBe(WS_A1);
  });

  it('keeps organization-level rows away from a workspace-scoped reader', async () => {
    const { entries } = await listActivity(managerA);

    expect(entries.some((entry) => entry.workspaceId === null)).toBe(false);
  });

  it('filters to one resource for a per-object history', async () => {
    const post = await platformDb.auditLog.findFirstOrThrow({
      where: { organizationId: ORG_A, workspaceId: WS_A2 },
    });
    await platformDb.auditLog.update({
      where: { id: post.id },
      data: { resourceId: ORG_A },
    });

    const { entries } = await listActivity(ownerA, { resourceId: ORG_A });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(post.id);
  });

  it('pages by keyset without repeating or skipping a row', async () => {
    const first = await listActivity(ownerA, { limit: 2 });
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listActivity(ownerA, { limit: 2, before: first.nextCursor! });
    const ids = new Set([...first.entries, ...second.entries].map((entry) => entry.id));

    expect(second.entries).toHaveLength(1);
    expect(ids.size).toBe(3);
  });
});
