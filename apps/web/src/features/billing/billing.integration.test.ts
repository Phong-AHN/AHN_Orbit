import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { ConflictError, NotFoundError, ValidationError, type TenantContext } from '@orbit/core';
import {
  SESSION_COOKIE_NAME,
  devIdentityProvider,
  resolveTenantContext,
  resolveUser,
  type AuthenticatedUser,
} from '@orbit/auth';
import { platformDb } from '@orbit/db';
import { POST as requestRoute } from '../../../app/api/v1/orgs/[orgSlug]/billing/plan-request/route';
import { POST as decisionRoute } from '../../../app/api/v1/admin/plan-requests/[requestId]/decision/route';
import { decidePlanRequest } from '@/features/admin/plans';
import { getPlanOverview, requestPlanChange, withdrawPlanRequest } from './service';
import { TRIAL_LIMITS, findPlan } from './plans';

/**
 * Changing plan by hand (D-116), through the real authenticated path.
 *
 * What has to hold: only an Owner can ask; only a platform administrator can
 * answer, and only with the plan that was asked for; one organization cannot
 * see or touch another's request; and every answer is in the organization's
 * own audit log, committed with the plan change.
 */

const A = {
  org: '018ffb16-0000-7000-8000-0000fb160001',
  slug: 'd116-tenant-a',
  owner: '018ffb16-0000-7000-8000-0000fb160002',
  ownerEmail: 'owner@d116a.test',
  admin: '018ffb16-0000-7000-8000-0000fb160003',
  adminEmail: 'admin@d116a.test',
};

const B = {
  org: '018ffb16-0000-7000-8000-0000fb16000b',
  slug: 'd116-tenant-b',
  owner: '018ffb16-0000-7000-8000-0000fb16000c',
  ownerEmail: 'owner@d116b.test',
};

const PLATFORM_ADMIN = {
  id: '018ffb16-0000-7000-8000-0000fb160010',
  email: 'ops@d116.test',
};

const fingerprint = { ip: '127.0.0.1', userAgent: 'vitest' };

let ctxA: TenantContext;
let ctxB: TenantContext;
let operator: AuthenticatedUser;

async function contextFor(email: string, orgId: string): Promise<TenantContext> {
  const identity = await devIdentityProvider.verifyIdToken(`dev:${email}`);
  const user = await resolveUser(identity);
  const { ctx } = await resolveTenantContext(user, orgId);
  return ctx;
}

async function session(email: string): Promise<string> {
  return devIdentityProvider.createSessionCookie(`dev:${email}`, 3_600_000);
}

function post(path: string, cookie: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
    }),
    body: JSON.stringify(body),
  });
}

const params = <P>(value: P) => ({ params: Promise.resolve(value) });

async function resetSubscription(org: string, limits: object = TRIAL_LIMITS) {
  await platformDb.subscription.upsert({
    where: { organizationId: org },
    update: { plan: 'trial', status: 'TRIALING', limits },
    create: { organizationId: org, plan: 'trial', status: 'TRIALING', seats: 5, limits },
  });
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
    where: { id: A.admin },
    update: {},
    create: { id: A.admin, firebaseUid: `dev:${A.adminEmail}`, email: A.adminEmail },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: A.org, userId: A.admin } },
    update: { role: 'ADMIN', status: 'ACTIVE' },
    create: { organizationId: A.org, userId: A.admin, role: 'ADMIN', status: 'ACTIVE' },
  });

  await platformDb.user.upsert({
    where: { id: PLATFORM_ADMIN.id },
    update: { isPlatformAdmin: true },
    create: {
      id: PLATFORM_ADMIN.id,
      firebaseUid: `dev:${PLATFORM_ADMIN.email}`,
      email: PLATFORM_ADMIN.email,
      isPlatformAdmin: true,
    },
  });

  ctxA = await contextFor(A.ownerEmail, A.org);
  ctxB = await contextFor(B.ownerEmail, B.org);
  operator = await resolveUser(
    await devIdentityProvider.verifyIdToken(`dev:${PLATFORM_ADMIN.email}`),
  );
});

beforeEach(async () => {
  await platformDb.planRequest.deleteMany({ where: { organizationId: { in: [A.org, B.org] } } });
  await platformDb.auditLog.deleteMany({ where: { organizationId: { in: [A.org, B.org] } } });
  await resetSubscription(A.org);
  await resetSubscription(B.org);
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [A.org, B.org] } } });
  await platformDb.user.deleteMany({
    where: { email: { in: [A.ownerEmail, A.adminEmail, B.ownerEmail, PLATFORM_ADMIN.email] } },
  });
  await platformDb.$disconnect();
});

describe('asking for a plan', () => {
  it('records the request and changes nothing about the plan yet', async () => {
    const request = await requestPlanChange(
      ctxA,
      { plan: 'growth', note: 'Call Lan' },
      fingerprint,
    );

    expect(request).toMatchObject({ plan: 'growth', status: 'PENDING', note: 'Call Lan' });

    const subscription = await platformDb.subscription.findUnique({
      where: { organizationId: A.org },
    });
    expect(subscription).toMatchObject({ plan: 'trial', status: 'TRIALING' });

    const audit = await platformDb.auditLog.findFirst({
      where: { organizationId: A.org, action: 'subscription.plan_requested' },
    });
    expect(audit).toMatchObject({ actorUserId: A.owner, resourceId: request.id });
  });

  it('allows one waiting request at a time', async () => {
    await requestPlanChange(ctxA, { plan: 'growth' }, fingerprint);
    await expect(requestPlanChange(ctxA, { plan: 'agency' }, fingerprint)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('refuses the plan the organization is already on', async () => {
    await platformDb.subscription.update({
      where: { organizationId: A.org },
      data: { plan: 'growth' },
    });
    await expect(requestPlanChange(ctxA, { plan: 'growth' }, fingerprint)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('refuses an organization with no limits, which an approval would cap (D-113)', async () => {
    await resetSubscription(A.org, {});
    await expect(requestPlanChange(ctxA, { plan: 'starter' }, fingerprint)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('can be withdrawn by the organization', async () => {
    await requestPlanChange(ctxA, { plan: 'growth' }, fingerprint);
    const withdrawn = await withdrawPlanRequest(ctxA, fingerprint);
    expect(withdrawn.status).toBe('WITHDRAWN');
    expect((await getPlanOverview(ctxA)).pendingRequest).toBeNull();
  });

  it('is invisible to another organization, which cannot withdraw it either', async () => {
    await requestPlanChange(ctxA, { plan: 'growth' }, fingerprint);

    expect((await getPlanOverview(ctxB)).pendingRequest).toBeNull();
    await expect(withdrawPlanRequest(ctxB, fingerprint)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getPlanOverview(ctxA)).pendingRequest?.plan).toBe('growth');
  });
});

describe('who may ask', () => {
  const path = `/api/v1/orgs/${A.slug}/billing/plan-request`;

  it('lets the Owner ask', async () => {
    const response = await requestRoute(
      post(path, await session(A.ownerEmail), { plan: 'starter' }),
      params({ orgSlug: A.slug }),
    );
    expect(response.status).toBe(201);
  });

  it('refuses an Admin, who can see the plan but not change it', async () => {
    const response = await requestRoute(
      post(path, await session(A.adminEmail), { plan: 'starter' }),
      params({ orgSlug: A.slug }),
    );
    expect(response.status).toBe(403);
    expect(await platformDb.planRequest.count({ where: { organizationId: A.org } })).toBe(0);
  });

  it('refuses a body that tries to say what the plan grants', async () => {
    const response = await requestRoute(
      post(path, await session(A.ownerEmail), { plan: 'starter', limits: {} }),
      params({ orgSlug: A.slug }),
    );
    expect(response.status).toBe(400);
  });
});

describe('answering a request', () => {
  it('applies the plan asked for, with its limits, and audits it in the organization', async () => {
    const request = await requestPlanChange(ctxA, { plan: 'growth' }, fingerprint);

    const decided = await decidePlanRequest(operator, request.id, {
      decision: 'APPROVE',
      reason: 'Paid by bank transfer, INV-0142',
    });
    expect(decided.status).toBe('APPROVED');

    const subscription = await platformDb.subscription.findUnique({
      where: { organizationId: A.org },
    });
    expect(subscription).toMatchObject({
      plan: 'growth',
      status: 'ACTIVE',
      limits: findPlan('growth')!.limits,
    });

    const audit = await platformDb.auditLog.findFirst({
      where: { organizationId: A.org, action: 'subscription.plan_changed' },
    });
    expect(audit).toMatchObject({
      actorUserId: PLATFORM_ADMIN.id,
      resourceId: request.id,
      reason: 'Paid by bank transfer, INV-0142',
    });
    expect(audit?.before).toMatchObject({ plan: 'trial', limits: TRIAL_LIMITS });
  });

  it('leaves the plan alone when declined', async () => {
    const request = await requestPlanChange(ctxA, { plan: 'agency' }, fingerprint);
    await decidePlanRequest(operator, request.id, {
      decision: 'DECLINE',
      reason: 'No payment received after two reminders',
    });

    const subscription = await platformDb.subscription.findUnique({
      where: { organizationId: A.org },
    });
    expect(subscription).toMatchObject({ plan: 'trial', limits: TRIAL_LIMITS });

    const overview = await getPlanOverview(ctxA);
    expect(overview.recentDecision).toMatchObject({ status: 'DECLINED', plan: 'agency' });
  });

  it('answers a request once', async () => {
    const request = await requestPlanChange(ctxA, { plan: 'growth' }, fingerprint);
    const reason = 'Paid by bank transfer, INV-0143';
    await decidePlanRequest(operator, request.id, { decision: 'APPROVE', reason });
    await expect(
      decidePlanRequest(operator, request.id, { decision: 'DECLINE', reason }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('cannot answer a withdrawn request', async () => {
    const request = await requestPlanChange(ctxA, { plan: 'growth' }, fingerprint);
    await withdrawPlanRequest(ctxA, fingerprint);
    await expect(
      decidePlanRequest(operator, request.id, {
        decision: 'APPROVE',
        reason: 'Paid by bank transfer, INV-0144',
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('is not even visible to an organization Owner: the admin route answers 404', async () => {
    const request = await requestPlanChange(ctxA, { plan: 'growth' }, fingerprint);
    const response = await decisionRoute(
      post(`/api/v1/admin/plan-requests/${request.id}/decision`, await session(A.ownerEmail), {
        decision: 'APPROVE',
        reason: 'I would like this plan please',
      }),
      params({ requestId: request.id }),
    );

    expect(response.status).toBe(404);
    expect(
      await platformDb.subscription.findUnique({ where: { organizationId: A.org } }),
    ).toMatchObject({ plan: 'trial' });
  });

  it('refuses an administrator who tries to name a different plan', async () => {
    const request = await requestPlanChange(ctxA, { plan: 'starter' }, fingerprint);
    const response = await decisionRoute(
      post(
        `/api/v1/admin/plan-requests/${request.id}/decision`,
        await session(PLATFORM_ADMIN.email),
        {
          decision: 'APPROVE',
          reason: 'Upgrading them further as a favour',
          plan: 'agency',
        },
      ),
      params({ requestId: request.id }),
    );

    expect(response.status).toBe(400);
    expect(
      await platformDb.subscription.findUnique({ where: { organizationId: A.org } }),
    ).toMatchObject({ plan: 'trial' });
  });
});
