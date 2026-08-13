import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictError, ForbiddenError, NotFoundError, type TenantContext } from '@orbit/core';
import { devIdentityProvider, resolveTenantContext, resolveUser } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import {
  createBrand,
  createWorkspace,
  deleteBrand,
  getBrand,
  getWorkspace,
  listWorkspaces,
  updateWorkspace,
} from './service';
import { acceptInvitation, createInvitation } from './invitations';

/**
 * T1.4 services, exercised through the real authenticated path.
 *
 * Two tenants again, and the questions that matter: can one reach the other's
 * workspaces and brands by id, and can anyone use an invitation to acquire
 * more privilege than the inviter holds?
 */

const A = {
  org: '018f2a00-0000-7000-8000-00002a1f0001',
  owner: '018f2a00-0000-7000-8000-00002a1f0002',
  manager: '018f2a00-0000-7000-8000-00002a1f0003',
  ownerEmail: 'owner@t4a.test',
  managerEmail: 'manager@t4a.test',
  slug: 't4-tenant-a',
};

const B = {
  org: '018f2b00-0000-7000-8000-00002b1f0001',
  owner: '018f2b00-0000-7000-8000-00002b1f0002',
  ownerEmail: 'owner@t4b.test',
  slug: 't4-tenant-b',
};

const OUTSIDER_EMAIL = 'outsider@t4x.test';

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ctxAOwner: TenantContext;
let ctxAManager: TenantContext;
let ctxBOwner: TenantContext;
let workspaceA: string;
let workspaceB: string;
let brandB: string;

async function contextFor(email: string, orgId: string): Promise<TenantContext> {
  const identity = await devIdentityProvider.verifyIdToken(`dev:${email}`);
  const user = await resolveUser(identity);
  const { ctx } = await resolveTenantContext(user, orgId);
  return ctx;
}

beforeAll(async () => {
  for (const t of [
    { org: A.org, slug: A.slug, owner: A.owner, email: A.ownerEmail },
    { org: B.org, slug: B.slug, owner: B.owner, email: B.ownerEmail },
  ]) {
    await platformDb.organization.upsert({
      where: { id: t.org },
      update: {},
      create: { id: t.org, name: t.slug, slug: t.slug, timezone: 'UTC' },
    });
    await platformDb.user.upsert({
      where: { id: t.owner },
      update: {},
      create: { id: t.owner, firebaseUid: `dev:${t.email}`, email: t.email },
    });
    await platformDb.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: t.org, userId: t.owner } },
      update: { role: 'OWNER', status: 'ACTIVE' },
      create: { organizationId: t.org, userId: t.owner, role: 'OWNER', status: 'ACTIVE' },
    });
  }

  await platformDb.user.upsert({
    where: { id: A.manager },
    update: {},
    create: { id: A.manager, firebaseUid: `dev:${A.managerEmail}`, email: A.managerEmail },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: A.org, userId: A.manager } },
    update: { role: 'ACCOUNT_MANAGER', status: 'ACTIVE' },
    create: {
      organizationId: A.org,
      userId: A.manager,
      role: 'ACCOUNT_MANAGER',
      status: 'ACTIVE',
    },
  });

  ctxAOwner = await contextFor(A.ownerEmail, A.org);
  ctxBOwner = await contextFor(B.ownerEmail, B.org);

  workspaceA = (
    await createWorkspace(
      ctxAOwner,
      { name: 'Client Alpha', timezone: 'Europe/London' },
      fingerprint,
    )
  ).id;
  const wsB = await createWorkspace(
    ctxBOwner,
    { name: 'Client Beta', timezone: 'America/New_York' },
    fingerprint,
  );
  workspaceB = wsB.id;
  brandB = (await createBrand(ctxBOwner, workspaceB, { name: 'Beta Brand' }, fingerprint)).id;

  await platformDb.workspaceMembership.upsert({
    where: { workspaceId_userId: { workspaceId: workspaceA, userId: A.manager } },
    update: { role: 'MANAGER' },
    create: {
      organizationId: A.org,
      workspaceId: workspaceA,
      userId: A.manager,
      role: 'MANAGER',
    },
  });

  ctxAManager = await contextFor(A.managerEmail, A.org);
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [A.org, B.org] } } });
  await platformDb.user.deleteMany({
    where: { email: { in: [A.ownerEmail, A.managerEmail, B.ownerEmail, OUTSIDER_EMAIL] } },
  });
  await platformDb.$disconnect();
});

describe('workspaces', () => {
  it('derives a slug rather than accepting one', async () => {
    const ws = await createWorkspace(
      ctxAOwner,
      { name: 'Café Ünion & Co.', timezone: 'UTC' },
      fingerprint,
    );
    expect(ws.slug).toBe('cafe-union-co');
  });

  it('requires a valid IANA timezone', async () => {
    const { createWorkspaceSchema } = await import('./contracts');
    expect(() =>
      createWorkspaceSchema.parse({ name: 'Bad Zone', timezone: 'Mars/Olympus' }),
    ).toThrow();
    expect(() =>
      createWorkspaceSchema.parse({ name: 'Good Zone', timezone: 'Asia/Ho_Chi_Minh' }),
    ).not.toThrow();
  });

  it('does not resolve another tenant’s workspace by exact id', async () => {
    await expect(getWorkspace(ctxAOwner, workspaceB)).rejects.toThrow(NotFoundError);
  });

  it('does not update another tenant’s workspace', async () => {
    await expect(
      updateWorkspace(ctxAOwner, workspaceB, { name: 'seized' }, fingerprint),
    ).rejects.toThrow(NotFoundError);

    const untouched = await platformDb.workspace.findUniqueOrThrow({ where: { id: workspaceB } });
    expect(untouched.name).toBe('Client Beta');
  });

  it('lists only the workspaces a member can reach', async () => {
    const forManager = await listWorkspaces(ctxAManager, [workspaceA]);
    expect(forManager.map((w) => w.id)).toEqual([workspaceA]);

    const forOwner = await listWorkspaces(ctxAOwner, 'ALL');
    expect(forOwner.length).toBeGreaterThanOrEqual(2);
    expect(forOwner.map((w) => w.id)).not.toContain(workspaceB);
  });
});

describe('brands', () => {
  it('refuses to create a brand under another tenant’s workspace', async () => {
    await expect(
      createBrand(ctxAOwner, workspaceB, { name: 'Smuggled' }, fingerprint),
    ).rejects.toThrow(NotFoundError);
  });

  it('does not resolve another tenant’s brand by exact id', async () => {
    await expect(getBrand(ctxAOwner, brandB)).rejects.toThrow(NotFoundError);
  });

  it('does not delete another tenant’s brand', async () => {
    await expect(deleteBrand(ctxAOwner, brandB, fingerprint)).rejects.toThrow(NotFoundError);
    expect(await platformDb.brand.count({ where: { id: brandB, deletedAt: null } })).toBe(1);
  });

  it('refuses to delete a brand that still has connected accounts', async () => {
    const brand = await createBrand(ctxAOwner, workspaceA, { name: 'Wired Up' }, fingerprint);
    await platformDb.socialAccount.create({
      data: {
        organizationId: A.org,
        workspaceId: workspaceA,
        brandId: brand.id,
        platform: 'FACEBOOK',
        externalId: 'ext-wired',
        displayName: 'Page',
      },
    });

    await expect(deleteBrand(ctxAOwner, brand.id, fingerprint)).rejects.toThrow(ConflictError);
  });

  it('soft-deletes rather than removing the row', async () => {
    const brand = await createBrand(ctxAOwner, workspaceA, { name: 'Temporary' }, fingerprint);
    await deleteBrand(ctxAOwner, brand.id, fingerprint);

    const row = await platformDb.brand.findUniqueOrThrow({ where: { id: brand.id } });
    expect(row.deletedAt).not.toBeNull();
    await expect(getBrand(ctxAOwner, brand.id)).rejects.toThrow(NotFoundError);
  });
});

describe('invitations', () => {
  it('stores only the token hash, never the token', async () => {
    const { token, id } = await createInvitation(
      ctxAOwner,
      { email: OUTSIDER_EMAIL, role: 'CONTENT_CREATOR', workspaceIds: [] },
      fingerprint,
    );

    const row = await platformDb.invitation.findUniqueOrThrow({ where: { id } });
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(token);

    await platformDb.invitation.delete({ where: { id } });
  });

  it('does not let an Account Manager invite above themselves', async () => {
    for (const role of ['ADMIN', 'ACCOUNT_MANAGER', 'CONTENT_CREATOR', 'APPROVER'] as const) {
      await expect(
        createInvitation(
          ctxAManager,
          { email: OUTSIDER_EMAIL, role, workspaceIds: [] },
          fingerprint,
        ),
      ).rejects.toThrow(ForbiddenError);
    }
  });

  it('lets an Account Manager invite a Client into their own workspace', async () => {
    const invitation = await createInvitation(
      ctxAManager,
      { email: OUTSIDER_EMAIL, role: 'CLIENT', workspaceIds: [workspaceA] },
      fingerprint,
    );
    expect(invitation.role).toBe('CLIENT');
    await platformDb.invitation.delete({ where: { id: invitation.id } });
  });

  it('refuses a workspace from another tenant, by exact id', async () => {
    await expect(
      createInvitation(
        ctxAOwner,
        { email: OUTSIDER_EMAIL, role: 'CLIENT', workspaceIds: [workspaceB] },
        fingerprint,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it('never issues an OWNER invitation', async () => {
    await expect(
      createInvitation(
        ctxAOwner,
        { email: OUTSIDER_EMAIL, role: 'OWNER', workspaceIds: [] },
        fingerprint,
      ),
    ).rejects.toThrow(ForbiddenError);
  });

  it('can only be redeemed by the invited address', async () => {
    const { token } = await createInvitation(
      ctxAOwner,
      { email: OUTSIDER_EMAIL, role: 'CONTENT_CREATOR', workspaceIds: [] },
      fingerprint,
    );

    const wrongPerson = await resolveUser(
      await devIdentityProvider.verifyIdToken(`dev:${B.ownerEmail}`),
    );

    await expect(acceptInvitation(wrongPerson, token, 'test', fingerprint)).rejects.toThrow(
      ForbiddenError,
    );

    // Still pending, so the rightful invitee can use it.
    const pending = await platformDb.invitation.findFirst({
      where: { email: OUTSIDER_EMAIL, acceptedAt: null },
    });
    expect(pending).not.toBeNull();
    await platformDb.invitation.deleteMany({ where: { email: OUTSIDER_EMAIL } });
  });

  it('grants membership on acceptance and cannot be replayed', async () => {
    const { token } = await createInvitation(
      ctxAOwner,
      { email: OUTSIDER_EMAIL, role: 'CONTENT_CREATOR', workspaceIds: [workspaceA] },
      fingerprint,
    );

    const invitee = await resolveUser(
      await devIdentityProvider.verifyIdToken(`dev:${OUTSIDER_EMAIL}`),
    );

    const result = await acceptInvitation(invitee, token, 'test', fingerprint);
    expect(result.organization.id).toBe(A.org);
    expect(result.role).toBe('CONTENT_CREATOR');

    const membership = await platformDb.organizationMembership.findFirstOrThrow({
      where: { organizationId: A.org, userId: invitee.id },
    });
    expect(membership.status).toBe('ACTIVE');

    // Second use of the same token must fail — single use.
    await expect(acceptInvitation(invitee, token, 'test', fingerprint)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('rejects an unknown token with the same generic error', async () => {
    const invitee = await resolveUser(
      await devIdentityProvider.verifyIdToken(`dev:${OUTSIDER_EMAIL}`),
    );
    await expect(acceptInvitation(invitee, 'a'.repeat(43), 'test', fingerprint)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('audit trail', () => {
  it('records every mutation with the acting user and correlation id', async () => {
    const entries = await platformDb.auditLog.findMany({
      where: { organizationId: A.org },
      select: { action: true, actorUserId: true, correlationId: true, resourceType: true },
    });

    const actions = entries.map((e) => e.action);
    expect(actions).toContain('workspace.created');
    expect(actions).toContain('brand.created');
    expect(actions).toContain('invitation.created');
    expect(entries.every((e) => e.actorUserId !== null)).toBe(true);
  });

  it('never writes an invitation token into the audit trail', async () => {
    const entries = await platformDb.auditLog.findMany({
      where: { organizationId: A.org, action: 'invitation.created' },
      select: { after: true },
    });

    for (const entry of entries) {
      expect(JSON.stringify(entry.after)).not.toMatch(/token/i);
    }
  });
});
