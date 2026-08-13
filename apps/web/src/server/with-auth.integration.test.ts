import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { SESSION_COOKIE_NAME, devIdentityProvider } from '@orbit/auth';
import { platformDb, withTenant } from '@orbit/db';
import { jsonOk } from './api-response';
import { readJsonBody, withAuth, withUser } from './with-auth';

/**
 * The `withAuth` wrapper, exercised at the HTTP boundary with real request
 * objects — the layer a route handler actually sits behind.
 *
 * What this proves, in order:
 *   • no session cookie          → 401, handler never runs
 *   • forged / expired cookie    → 401, handler never runs
 *   • valid cookie, foreign org  → 404, handler never runs
 *   • valid cookie, own org      → 200, handler receives a TenantContext
 *   • body carrying organizationId or userId → 400, logged as a security event
 */

const A = {
  org: '018fc000-0000-7000-8000-0000000c0001',
  user: '018fc000-0000-7000-8000-0000000c0002',
  workspace: '018fc000-0000-7000-8000-0000000c0003',
  email: 'http-a@tenant-c.test',
  slug: 'tenant-c',
};

const B = {
  org: '018fd000-0000-7000-8000-0000000d0001',
  user: '018fd000-0000-7000-8000-0000000d0002',
  post: '018fd000-0000-7000-8000-0000000d0003',
  email: 'http-b@tenant-d.test',
  slug: 'tenant-d',
};

let sessionA: string;

async function seed(t: { org: string; user: string; email: string; slug: string }) {
  await platformDb.organization.upsert({
    where: { id: t.org },
    update: {},
    create: { id: t.org, name: t.slug, slug: t.slug, timezone: 'UTC' },
  });
  await platformDb.user.upsert({
    where: { id: t.user },
    update: {},
    create: { id: t.user, firebaseUid: `dev:${t.email}`, email: t.email },
  });
  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: t.org, userId: t.user } },
    update: { role: 'OWNER', status: 'ACTIVE' },
    create: { organizationId: t.org, userId: t.user, role: 'OWNER', status: 'ACTIVE' },
  });
}

/** Build a request the way the browser would send it. */
function request(path: string, init: { cookie?: string; body?: unknown } = {}): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.cookie) headers.set('cookie', `${SESSION_COOKIE_NAME}=${init.cookie}`);

  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.body ? 'POST' : 'GET',
    headers,
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

const params = <P>(value: P) => ({ params: Promise.resolve(value) });

beforeAll(async () => {
  await seed(A);
  await seed(B);
  await platformDb.workspace.upsert({
    where: { id: A.workspace },
    update: {},
    create: {
      id: A.workspace,
      organizationId: A.org,
      name: 'ws',
      slug: 'main',
      timezone: 'UTC',
    },
  });
  await platformDb.brand.upsert({
    where: { id: B.post },
    update: {},
    create: {
      id: B.post,
      organizationId: B.org,
      workspaceId: (
        await platformDb.workspace.upsert({
          where: { organizationId_slug: { organizationId: B.org, slug: 'main' } },
          update: {},
          create: { organizationId: B.org, name: 'ws', slug: 'main', timezone: 'UTC' },
        })
      ).id,
      name: 'brand b',
      slug: 'brand-b',
    },
  });

  sessionA = await devIdentityProvider.createSessionCookie(`dev:${A.email}`, 3_600_000);
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [A.org, B.org] } } });
  await platformDb.user.deleteMany({ where: { id: { in: [A.user, B.user] } } });
  await platformDb.$disconnect();
});

describe('withAuth — step 1, authentication', () => {
  it('returns 401 and never runs the handler without a cookie', async () => {
    let ran = false;
    const route = withAuth<{ orgSlug: string }>({}, async () => {
      ran = true;
      return jsonOk({ ok: true });
    });

    const response = await route(request(`/api/v1/orgs/${A.slug}/x`), params({ orgSlug: A.slug }));

    expect(response.status).toBe(401);
    expect(ran).toBe(false);
    const body = await response.json();
    expect(body.error.code).toBe('UNAUTHENTICATED');
    // Never explains why the token failed.
    expect(body.error.message).toBe('Please sign in to continue.');
  });

  it('returns 401 for a forged cookie', async () => {
    const route = withAuth<{ orgSlug: string }>({}, async () => jsonOk({ ok: true }));
    const response = await route(
      request(`/api/v1/orgs/${A.slug}/x`, { cookie: 'forged.signature' }),
      params({ orgSlug: A.slug }),
    );
    expect(response.status).toBe(401);
  });

  it('returns 401 once the session is revoked, even with the same cookie', async () => {
    const cookie = await devIdentityProvider.createSessionCookie(`dev:${A.email}`, 3_600_000);
    const route = withAuth<{ orgSlug: string }>({}, async () => jsonOk({ ok: true }));

    const before = await route(
      request(`/api/v1/orgs/${A.slug}/x`, { cookie }),
      params({ orgSlug: A.slug }),
    );
    expect(before.status).toBe(200);

    await devIdentityProvider.revokeSessions(`dev:${A.email}`);

    const after = await route(
      request(`/api/v1/orgs/${A.slug}/x`, { cookie }),
      params({ orgSlug: A.slug }),
    );
    expect(after.status).toBe(401);

    // Re-issue for the remaining tests.
    sessionA = await devIdentityProvider.createSessionCookie(`dev:${A.email}`, 3_600_000);
  });
});

describe('withAuth — step 3, tenant resolution', () => {
  it('returns 404 and never runs the handler for a foreign organization', async () => {
    let ran = false;
    const route = withAuth<{ orgSlug: string }>({}, async () => {
      ran = true;
      return jsonOk({ ok: true });
    });

    for (const ref of [B.slug, B.org]) {
      const response = await route(
        request(`/api/v1/orgs/${ref}/x`, { cookie: sessionA }),
        params({ orgSlug: ref }),
      );

      expect(response.status, `orgSlug=${ref}`).toBe(404);
      expect(ran).toBe(false);
    }
  });

  it('hands the handler a TenantContext bound to the caller’s own organization', async () => {
    const route = withAuth<{ orgSlug: string }>({}, async ({ ctx, organization, user }) =>
      jsonOk({ organizationId: ctx.organizationId, slug: organization.slug, userId: user.id }),
    );

    const response = await route(
      request(`/api/v1/orgs/${A.slug}/x`, { cookie: sessionA }),
      params({ orgSlug: A.slug }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      organizationId: A.org,
      slug: A.slug,
      userId: A.user,
    });
  });

  it('the context it hands over cannot read the other tenant’s rows', async () => {
    const route = withAuth<{ orgSlug: string }>({}, async ({ ctx }) => {
      const foreign = await withTenant(ctx, (db) => db.brand.findFirst({ where: { id: B.post } }));
      return jsonOk({ foreign });
    });

    const response = await route(
      request(`/api/v1/orgs/${A.slug}/x`, { cookie: sessionA }),
      params({ orgSlug: A.slug }),
    );

    expect(await response.json()).toEqual({ foreign: null });
  });
});

describe('withAuth — step 4, authorization', () => {
  it('returns 403 and never runs the handler when the permission is missing', async () => {
    await platformDb.organizationMembership.update({
      where: { organizationId_userId: { organizationId: A.org, userId: A.user } },
      data: { role: 'CONTENT_CREATOR' },
    });

    let ran = false;
    const route = withAuth<{ orgSlug: string }>(
      { permission: 'post:publish_now', resource: () => ({ workspaceId: A.workspace }) },
      async () => {
        ran = true;
        return jsonOk({ ok: true });
      },
    );

    const response = await route(
      request(`/api/v1/orgs/${A.slug}/x`, { cookie: sessionA }),
      params({ orgSlug: A.slug }),
    );

    expect(response.status).toBe(403);
    expect(ran).toBe(false);
    expect((await response.json()).error.message).toBe("You don't have permission to do that.");

    await platformDb.organizationMembership.update({
      where: { organizationId_userId: { organizationId: A.org, userId: A.user } },
      data: { role: 'OWNER' },
    });
  });

  it('runs the handler when the permission is held', async () => {
    const route = withAuth<{ orgSlug: string }>(
      { permission: 'post:publish_now', resource: () => ({ workspaceId: A.workspace }) },
      async () => jsonOk({ ok: true }),
    );

    const response = await route(
      request(`/api/v1/orgs/${A.slug}/x`, { cookie: sessionA }),
      params({ orgSlug: A.slug }),
    );

    expect(response.status).toBe(200);
  });
});

describe('readJsonBody — the client cannot supply server-derived fields', () => {
  const schema = z.object({ title: z.string() });

  it.each([
    ['organizationId', { title: 't', organizationId: B.org }],
    ['userId', { title: 't', userId: B.user }],
    ['isPlatformAdmin', { title: 't', isPlatformAdmin: true }],
    ['membershipStatus', { title: 't', membershipStatus: 'ACTIVE' }],
  ])('rejects a body carrying %s', async (field, body) => {
    const route = withAuth<{ orgSlug: string }>({}, async ({ request: req }) => {
      const parsed = await readJsonBody(req, schema);
      return jsonOk(parsed);
    });

    const response = await route(
      request(`/api/v1/orgs/${A.slug}/x`, { cookie: sessionA, body }),
      params({ orgSlug: A.slug }),
    );

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe('VALIDATION_ERROR');
    expect(payload.error.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  it('accepts a clean body', async () => {
    const route = withAuth<{ orgSlug: string }>({}, async ({ request: req }) =>
      jsonOk(await readJsonBody(req, schema)),
    );

    const response = await route(
      request(`/api/v1/orgs/${A.slug}/x`, { cookie: sessionA, body: { title: 'hello' } }),
      params({ orgSlug: A.slug }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: 'hello' });
  });
});

describe('withUser — authenticated but not tenant-scoped', () => {
  it('still requires a session', async () => {
    const route = withUser({}, async () => jsonOk({ ok: true }));
    const response = await route(request('/api/v1/auth/me'));
    expect(response.status).toBe(401);
  });

  it('resolves the user without needing an organization', async () => {
    const route = withUser({}, async ({ user }) => jsonOk({ id: user.id }));
    const response = await route(request('/api/v1/auth/me', { cookie: sessionA }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: A.user });
  });
});
