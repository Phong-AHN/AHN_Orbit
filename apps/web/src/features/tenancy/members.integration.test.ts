import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, type TenantContext } from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import {
  addWorkspaceMember,
  listMembers,
  listWorkspaceMembers,
  removeMember,
  removeWorkspaceMember,
  updateMemberRole,
} from './members';

/**
 * Member management (T1.4).
 *
 * The interesting cases are all refusals: self-promotion, an admin reaching
 * above themselves, the last owner being removed, and anything crossing a
 * tenant boundary.
 */

const ORG_A = '018f3a00-0000-7000-8000-00003a1f0001';
const ORG_B = '018f3b00-0000-7000-8000-00003b1f0001';
const WS_A = '018f3a00-0000-7000-8000-00003a1f0010';
const WS_B = '018f3b00-0000-7000-8000-00003b1f0010';

const U = {
  owner: { id: '018f3a00-0000-7000-8000-00003a1f0002', email: 'owner@m4.test' },
  owner2: { id: '018f3a00-0000-7000-8000-00003a1f0003', email: 'owner2@m4.test' },
  admin: { id: '018f3a00-0000-7000-8000-00003a1f0004', email: 'admin@m4.test' },
  manager: { id: '018f3a00-0000-7000-8000-00003a1f0005', email: 'manager@m4.test' },
  creator: { id: '018f3a00-0000-7000-8000-00003a1f0006', email: 'creator@m4.test' },
  client: { id: '018f3a00-0000-7000-8000-00003a1f0007', email: 'client@m4.test' },
  outsider: { id: '018f3b00-0000-7000-8000-00003b1f0002', email: 'outsider@m4b.test' },
};

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ctxOwner: TenantContext;
let ctxAdmin: TenantContext;
let ctxManager: TenantContext;

async function contextFor(email: string, orgId: string): Promise<TenantContext> {
  const identity = await devIdentityProvider.verifyIdToken(`dev:${email}`);
  const user = await resolveUser(identity);
  const { ctx } = await resolveTenantContext(user, orgId);
  return ctx;
}

/** Rebuilt before each test, so one test's mutations cannot shape the next. */
async function resetMemberships() {
  await platformDb.workspaceMembership.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  });
  await platformDb.organizationMembership.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  });

  const roles = [
    [U.owner.id, 'OWNER'],
    [U.owner2.id, 'OWNER'],
    [U.admin.id, 'ADMIN'],
    [U.manager.id, 'ACCOUNT_MANAGER'],
    [U.creator.id, 'CONTENT_CREATOR'],
    [U.client.id, 'CLIENT'],
  ] as const;

  for (const [userId, role] of roles) {
    await platformDb.organizationMembership.create({
      data: { organizationId: ORG_A, userId, role, status: 'ACTIVE' },
    });
  }

  await platformDb.organizationMembership.create({
    data: { organizationId: ORG_B, userId: U.outsider.id, role: 'OWNER', status: 'ACTIVE' },
  });

  await platformDb.workspaceMembership.create({
    data: { organizationId: ORG_A, workspaceId: WS_A, userId: U.manager.id, role: 'MANAGER' },
  });
}

beforeAll(async () => {
  for (const [orgId, slug] of [
    [ORG_A, 'm4-tenant-a'],
    [ORG_B, 'm4-tenant-b'],
  ] as const) {
    await platformDb.organization.upsert({
      where: { id: orgId },
      update: {},
      create: { id: orgId, name: slug, slug, timezone: 'UTC' },
    });
  }

  for (const user of Object.values(U)) {
    await platformDb.user.upsert({
      where: { id: user.id },
      update: {},
      create: { id: user.id, firebaseUid: `dev:${user.email}`, email: user.email },
    });
  }

  for (const [id, orgId, name] of [
    [WS_A, ORG_A, 'ws-a'],
    [WS_B, ORG_B, 'ws-b'],
  ] as const) {
    await platformDb.workspace.upsert({
      where: { id },
      update: {},
      create: { id, organizationId: orgId, name, slug: 'main', timezone: 'UTC' },
    });
  }
});

beforeEach(async () => {
  await resetMemberships();
  ctxOwner = await contextFor(U.owner.email, ORG_A);
  ctxAdmin = await contextFor(U.admin.email, ORG_A);
  ctxManager = await contextFor(U.manager.email, ORG_A);
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await platformDb.user.deleteMany({ where: { id: { in: Object.values(U).map((u) => u.id) } } });
  await platformDb.$disconnect();
});

describe('listing members', () => {
  it('returns this organization’s members only', async () => {
    const members = await listMembers(ctxOwner);
    const emails = members.map((m) => m.user.email);

    expect(emails).toContain(U.owner.email);
    expect(emails).toContain(U.client.email);
    expect(emails).not.toContain(U.outsider.email);
  });
});

describe('changing a role', () => {
  it('lets an owner promote a creator', async () => {
    await updateMemberRole(ctxOwner, U.creator.id, 'APPROVER', fingerprint);

    const membership = await platformDb.organizationMembership.findFirstOrThrow({
      where: { organizationId: ORG_A, userId: U.creator.id },
    });
    expect(membership.role).toBe('APPROVER');
  });

  it('refuses self-promotion — the escalation path that matters most', async () => {
    await expect(updateMemberRole(ctxAdmin, U.admin.id, 'OWNER', fingerprint)).rejects.toThrow(
      ForbiddenError,
    );

    const unchanged = await platformDb.organizationMembership.findFirstOrThrow({
      where: { organizationId: ORG_A, userId: U.admin.id },
    });
    expect(unchanged.role).toBe('ADMIN');
  });

  it('refuses an admin granting ownership to someone else', async () => {
    await expect(updateMemberRole(ctxAdmin, U.creator.id, 'OWNER', fingerprint)).rejects.toThrow(
      /Only an owner may grant ownership|owner/i,
    );
  });

  it('refuses an admin demoting an owner', async () => {
    await expect(updateMemberRole(ctxAdmin, U.owner.id, 'ADMIN', fingerprint)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('lets an owner demote another owner while one remains', async () => {
    await updateMemberRole(ctxOwner, U.owner2.id, 'ADMIN', fingerprint);
    const owners = await platformDb.organizationMembership.count({
      where: { organizationId: ORG_A, role: 'OWNER' },
    });
    expect(owners).toBe(1);
  });

  it('refuses demoting the last owner', async () => {
    await updateMemberRole(ctxOwner, U.owner2.id, 'ADMIN', fingerprint);
    // ctxOwner is now the only owner, and cannot act on themselves anyway;
    // an admin trying to demote them must also fail.
    await expect(updateMemberRole(ctxAdmin, U.owner.id, 'ADMIN', fingerprint)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('clears workspace seats when a client becomes staff', async () => {
    await platformDb.workspaceMembership.create({
      data: {
        organizationId: ORG_A,
        workspaceId: WS_A,
        userId: U.client.id,
        role: 'CLIENT_APPROVER',
      },
    });

    await updateMemberRole(ctxOwner, U.client.id, 'CONTENT_CREATOR', fingerprint);

    const seats = await platformDb.workspaceMembership.count({ where: { userId: U.client.id } });
    expect(seats).toBe(0);
  });

  it('does not find a member of another organization', async () => {
    await expect(updateMemberRole(ctxOwner, U.outsider.id, 'ADMIN', fingerprint)).rejects.toThrow(
      NotFoundError,
    );

    const untouched = await platformDb.organizationMembership.findFirstOrThrow({
      where: { organizationId: ORG_B, userId: U.outsider.id },
    });
    expect(untouched.role).toBe('OWNER');
  });
});

describe('removing a member', () => {
  it('removes a member and their workspace seats', async () => {
    await platformDb.workspaceMembership.create({
      data: { organizationId: ORG_A, workspaceId: WS_A, userId: U.creator.id, role: 'CONTRIBUTOR' },
    });

    await removeMember(ctxOwner, U.creator.id, fingerprint);

    expect(
      await platformDb.organizationMembership.count({
        where: { organizationId: ORG_A, userId: U.creator.id },
      }),
    ).toBe(0);
    expect(await platformDb.workspaceMembership.count({ where: { userId: U.creator.id } })).toBe(0);
  });

  it('refuses removing yourself', async () => {
    await expect(removeMember(ctxOwner, U.owner.id, fingerprint)).rejects.toThrow(ForbiddenError);
  });

  it('refuses an admin removing an owner', async () => {
    await expect(removeMember(ctxAdmin, U.owner.id, fingerprint)).rejects.toThrow(ForbiddenError);
  });

  it('refuses removing the last owner', async () => {
    await updateMemberRole(ctxOwner, U.owner2.id, 'ADMIN', fingerprint);
    const ctxOwner2AsAdmin = await contextFor(U.owner2.email, ORG_A);

    await expect(removeMember(ctxOwner2AsAdmin, U.owner.id, fingerprint)).rejects.toThrow(
      ForbiddenError,
    );
    expect(
      await platformDb.organizationMembership.count({
        where: { organizationId: ORG_A, role: 'OWNER' },
      }),
    ).toBe(1);
  });

  it('does not remove a member of another organization', async () => {
    await expect(removeMember(ctxOwner, U.outsider.id, fingerprint)).rejects.toThrow(NotFoundError);
  });
});

describe('workspace seats', () => {
  it('lets an owner add agency staff to a workspace', async () => {
    await addWorkspaceMember(ctxOwner, WS_A, U.creator.id, 'CONTRIBUTOR', fingerprint);
    const members = await listWorkspaceMembers(ctxOwner, WS_A);
    expect(members.map((m) => m.user.id)).toContain(U.creator.id);
  });

  it('lets an account manager add a client to their own workspace', async () => {
    await addWorkspaceMember(ctxManager, WS_A, U.client.id, 'CLIENT_APPROVER', fingerprint);
    const members = await listWorkspaceMembers(ctxManager, WS_A);
    expect(members.map((m) => m.user.id)).toContain(U.client.id);
  });

  it('refuses an account manager adding agency staff', async () => {
    await expect(
      addWorkspaceMember(ctxManager, WS_A, U.creator.id, 'CONTRIBUTOR', fingerprint),
    ).rejects.toThrow(/only assign client users/i);
  });

  it('refuses giving a client an internal workspace role', async () => {
    await expect(
      addWorkspaceMember(ctxOwner, WS_A, U.client.id, 'CONTRIBUTOR', fingerprint),
    ).rejects.toThrow(/does not match|client/i);
  });

  it('refuses giving agency staff a client role', async () => {
    await expect(
      addWorkspaceMember(ctxOwner, WS_A, U.creator.id, 'CLIENT_VIEWER', fingerprint),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses seating a user from another organization', async () => {
    await expect(
      addWorkspaceMember(ctxOwner, WS_A, U.outsider.id, 'CONTRIBUTOR', fingerprint),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses seating into another tenant’s workspace, by exact id', async () => {
    await expect(
      addWorkspaceMember(ctxOwner, WS_B, U.creator.id, 'CONTRIBUTOR', fingerprint),
    ).rejects.toThrow(NotFoundError);
  });

  it('refuses an account manager staffing a workspace they do not belong to', async () => {
    const other = await platformDb.workspace.create({
      data: { organizationId: ORG_A, name: 'unrelated', slug: 'unrelated', timezone: 'UTC' },
    });

    await expect(
      addWorkspaceMember(ctxManager, other.id, U.client.id, 'CLIENT_APPROVER', fingerprint),
    ).rejects.toThrow(ForbiddenError);

    await platformDb.workspace.delete({ where: { id: other.id } });
  });

  it('refuses seating someone who has not accepted their invitation', async () => {
    await platformDb.organizationMembership.updateMany({
      where: { organizationId: ORG_A, userId: U.creator.id },
      data: { status: 'INVITED' },
    });

    await expect(
      addWorkspaceMember(ctxOwner, WS_A, U.creator.id, 'CONTRIBUTOR', fingerprint),
    ).rejects.toThrow(ConflictError);
  });

  it('removes a seat', async () => {
    await addWorkspaceMember(ctxOwner, WS_A, U.creator.id, 'CONTRIBUTOR', fingerprint);
    await removeWorkspaceMember(ctxOwner, WS_A, U.creator.id, fingerprint);

    const members = await listWorkspaceMembers(ctxOwner, WS_A);
    expect(members.map((m) => m.user.id)).not.toContain(U.creator.id);
  });

  it('does not list members of another tenant’s workspace', async () => {
    await expect(listWorkspaceMembers(ctxOwner, WS_B)).rejects.toThrow(NotFoundError);
  });
});

describe('audit trail', () => {
  it('records role changes and removals with before and after', async () => {
    await updateMemberRole(ctxOwner, U.creator.id, 'APPROVER', fingerprint);
    await removeMember(ctxOwner, U.creator.id, fingerprint);

    const entries = await platformDb.auditLog.findMany({
      where: { organizationId: ORG_A, action: { in: ['member.role_changed', 'member.removed'] } },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.actorUserId === U.owner.id)).toBe(true);
    expect(JSON.stringify(entries)).toContain('CONTENT_CREATOR');
  });
});
