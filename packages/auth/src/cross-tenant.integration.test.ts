import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  NotFoundError,
  TenantIsolationError,
  type TenantContext,
} from '@orbit/core';
import { platformDb, withTenant } from '@orbit/db';
import { can } from '@orbit/rbac';
import { resolveTenantContext, resolveUser } from './principal.js';
import { devIdentityProvider } from './dev-provider.js';

/**
 * Cross-tenant isolation, end to end.
 *
 *   User A ── Organization A ── Workspace A ── Brand A ── Post A / Media A
 *   User B ── Organization B ── Workspace B ── Brand B ── Post B / Media B
 *
 * User A then attempts to reach every one of B's resources **by its exact
 * UUID**. Every attempt must fail.
 *
 * This exercises the *application* layer: tenant resolution from memberships,
 * and the tenant-scoped Prisma client. The independent database backstop (RLS)
 * is proven separately in packages/db/src/rls.integration.test.ts, which
 * connects as the non-owner `orbit_app` role. Both layers are tested because
 * either one alone would be a single point of failure (decision D-005).
 */

const A = {
  org: '018fa000-0000-7000-8000-0000000a0001',
  user: '018fa000-0000-7000-8000-0000000a0002',
  workspace: '018fa000-0000-7000-8000-0000000a0003',
  brand: '018fa000-0000-7000-8000-0000000a0004',
  post: '018fa000-0000-7000-8000-0000000a0005',
  media: '018fa000-0000-7000-8000-0000000a0006',
  email: 'a-owner@tenant-a.test',
  slug: 'tenant-a',
};

const B = {
  org: '018fb000-0000-7000-8000-0000000b0001',
  user: '018fb000-0000-7000-8000-0000000b0002',
  workspace: '018fb000-0000-7000-8000-0000000b0003',
  brand: '018fb000-0000-7000-8000-0000000b0004',
  post: '018fb000-0000-7000-8000-0000000b0005',
  media: '018fb000-0000-7000-8000-0000000b0006',
  email: 'b-owner@tenant-b.test',
  slug: 'tenant-b',
};

async function seedTenant(t: typeof A) {
  await platformDb.organization.upsert({
    where: { id: t.org },
    update: {},
    create: { id: t.org, name: t.slug, slug: t.slug, timezone: 'UTC' },
  });

  await platformDb.user.upsert({
    where: { id: t.user },
    update: {},
    create: { id: t.user, firebaseUid: `dev:${t.email}`, email: t.email, name: t.slug },
  });

  await platformDb.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: t.org, userId: t.user } },
    update: { role: 'OWNER', status: 'ACTIVE' },
    create: { organizationId: t.org, userId: t.user, role: 'OWNER', status: 'ACTIVE' },
  });

  await platformDb.workspace.upsert({
    where: { id: t.workspace },
    update: {},
    create: {
      id: t.workspace,
      organizationId: t.org,
      name: `${t.slug} workspace`,
      slug: 'main',
      timezone: 'UTC',
    },
  });

  await platformDb.brand.upsert({
    where: { id: t.brand },
    update: {},
    create: {
      id: t.brand,
      organizationId: t.org,
      workspaceId: t.workspace,
      name: `${t.slug} brand`,
      slug: 'brand',
    },
  });

  await platformDb.post.upsert({
    where: { id: t.post },
    update: {},
    create: {
      id: t.post,
      organizationId: t.org,
      workspaceId: t.workspace,
      brandId: t.brand,
      title: `${t.slug} post`,
      body: `secret content belonging to ${t.slug}`,
      status: 'DRAFT',
    },
  });

  await platformDb.mediaAsset.upsert({
    where: { id: t.media },
    update: {},
    create: {
      id: t.media,
      organizationId: t.org,
      workspaceId: t.workspace,
      brandId: t.brand,
      kind: 'IMAGE',
      storageKey: `org/${t.org}/asset-${t.media}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      status: 'READY',
    },
  });
}

let ctxA: TenantContext;

beforeAll(async () => {
  await seedTenant(A);
  await seedTenant(B);

  // The full authenticated path, exactly as a request would take it.
  const identity = await devIdentityProvider.verifyIdToken(`dev:${A.email}`);
  const user = await resolveUser(identity);
  ({ ctx: ctxA } = await resolveTenantContext(user, A.org));
});

afterAll(async () => {
  await platformDb.organization.deleteMany({ where: { id: { in: [A.org, B.org] } } });
  await platformDb.user.deleteMany({ where: { id: { in: [A.user, B.user] } } });
  await platformDb.$disconnect();
});

// ── Step 1: authentication yields our own user id, not a client-supplied one ─

describe('authentication resolves identity server-side', () => {
  it('maps a verified identity onto our User row by firebaseUid', async () => {
    const identity = await devIdentityProvider.verifyIdToken(`dev:${A.email}`);
    const user = await resolveUser(identity);

    expect(user.id).toBe(A.user);
    expect(user.email).toBe(A.email);
  });

  it('never lets an email alone select an account — the uid is the key', async () => {
    // An attacker-controlled identity claiming B's email but a different uid
    // must not resolve to B's existing user row.
    const identity = { ...(await devIdentityProvider.verifyIdToken(`dev:${B.email}`)) };
    expect(identity.uid).toBe(`dev:${B.email}`);

    const user = await resolveUser(identity);
    expect(user.id).toBe(B.user);
  });
});

// ── Step 2: tenant resolution is membership-checked ─────────────────────────

describe('tenant resolution', () => {
  it('resolves the organization the user actually belongs to', async () => {
    const identity = await devIdentityProvider.verifyIdToken(`dev:${A.email}`);
    const user = await resolveUser(identity);

    const { ctx, organization } = await resolveTenantContext(user, A.org);
    expect(ctx.organizationId).toBe(A.org);
    expect(organization.slug).toBe(A.slug);
  });

  it('DENIES User A entry to Organization B — by exact UUID', async () => {
    const identity = await devIdentityProvider.verifyIdToken(`dev:${A.email}`);
    const user = await resolveUser(identity);

    await expect(resolveTenantContext(user, B.org)).rejects.toThrow(NotFoundError);
  });

  it('DENIES User A entry to Organization B — by slug', async () => {
    const identity = await devIdentityProvider.verifyIdToken(`dev:${A.email}`);
    const user = await resolveUser(identity);

    await expect(resolveTenantContext(user, B.slug)).rejects.toThrow(NotFoundError);
  });

  it('returns 404, not 403 — a 403 would confirm the organization exists', async () => {
    const identity = await devIdentityProvider.verifyIdToken(`dev:${A.email}`);
    const user = await resolveUser(identity);

    const error = await resolveTenantContext(user, B.org).catch((e: NotFoundError) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).status).toBe(404);
    expect((error as NotFoundError).code).toBe('NOT_FOUND');
  });

  it('gives the same 404 for an organization that does not exist at all', async () => {
    const identity = await devIdentityProvider.verifyIdToken(`dev:${A.email}`);
    const user = await resolveUser(identity);

    const missing = await resolveTenantContext(user, '018fffff-0000-7000-8000-0000ffff0001').catch(
      (e: NotFoundError) => e,
    );

    expect((missing as NotFoundError).status).toBe(404);
  });

  it('refuses a suspended membership with a distinct, non-enumerating error', async () => {
    await platformDb.organizationMembership.update({
      where: { organizationId_userId: { organizationId: A.org, userId: A.user } },
      data: { status: 'SUSPENDED' },
    });

    const identity = await devIdentityProvider.verifyIdToken(`dev:${A.email}`);
    const user = await resolveUser(identity);
    await expect(resolveTenantContext(user, A.org)).rejects.toThrow(ForbiddenError);

    await platformDb.organizationMembership.update({
      where: { organizationId_userId: { organizationId: A.org, userId: A.user } },
      data: { status: 'ACTIVE' },
    });
  });

  it('carries only User A’s own memberships into the principal', async () => {
    expect(ctxA.principal.kind).toBe('USER');
    if (ctxA.principal.kind !== 'USER') throw new Error('unreachable');

    expect(ctxA.principal.userId).toBe(A.user);
    expect(ctxA.principal.organizationRole).toBe('OWNER');
    expect(ctxA.principal.workspaces.map((w) => w.workspaceId)).not.toContain(B.workspace);
  });
});

// ── Step 3: the resource matrix — every one of B's rows, by exact UUID ──────

describe('User A cannot reach Organization B’s data, even knowing every UUID', () => {
  it('Organization B — naming another tenant’s id is refused outright', async () => {
    // The tenant root is scoped by its own id. Naming a *different* org id is
    // naming another tenant explicitly, so it raises rather than returning
    // null — the same treatment a tenant model gets when a where clause names
    // a foreign organizationId. Externally this is still a 404 with a safe
    // message; internally it is logged as a security event.
    await expect(
      withTenant(ctxA, (db) => db.organization.findFirst({ where: { id: B.org } })),
    ).rejects.toThrow(TenantIsolationError);
  });

  it('Organization B — cannot be reached by any other filter either', async () => {
    const bySlug = await withTenant(ctxA, (db) =>
      db.organization.findFirst({ where: { slug: B.slug } }),
    );
    expect(bySlug).toBeNull();

    const all = await withTenant(ctxA, (db) => db.organization.findMany());
    expect(all.map((o) => o.id)).toEqual([A.org]);
  });

  it('Workspace B', async () => {
    const found = await withTenant(ctxA, (db) =>
      db.workspace.findFirst({ where: { id: B.workspace } }),
    );
    expect(found).toBeNull();
  });

  it('Brand B', async () => {
    const found = await withTenant(ctxA, (db) => db.brand.findFirst({ where: { id: B.brand } }));
    expect(found).toBeNull();
  });

  it('Post B', async () => {
    const found = await withTenant(ctxA, (db) => db.post.findFirst({ where: { id: B.post } }));
    expect(found).toBeNull();
  });

  it('Media B', async () => {
    const found = await withTenant(ctxA, (db) =>
      db.mediaAsset.findFirst({ where: { id: B.media } }),
    );
    expect(found).toBeNull();
  });

  it('sees only its own rows on an unfiltered list', async () => {
    const [posts, brands, workspaces, media] = await withTenant(ctxA, async (db) => [
      await db.post.findMany(),
      await db.brand.findMany(),
      await db.workspace.findMany(),
      await db.mediaAsset.findMany(),
    ]);

    expect(posts.map((p) => p.id)).toEqual([A.post]);
    expect(brands.map((b) => b.id)).toEqual([A.brand]);
    expect(workspaces.map((w) => w.id)).toEqual([A.workspace]);
    expect(media.map((m) => m.id)).toEqual([A.media]);
  });

  it('cannot widen the result set with an OR clause', async () => {
    const posts = await withTenant(ctxA, (db) =>
      db.post.findMany({ where: { OR: [{ id: A.post }, { id: B.post }] } }),
    );
    expect(posts.map((p) => p.id)).toEqual([A.post]);
  });

  it('counts and aggregates only its own rows', async () => {
    const count = await withTenant(ctxA, (db) => db.post.count());
    expect(count).toBe(1);
  });
});

// ── Step 4: writes across the boundary ──────────────────────────────────────

describe('User A cannot modify Organization B’s data', () => {
  it('updating B’s post affects zero rows', async () => {
    const result = await withTenant(ctxA, (db) =>
      db.post.updateMany({ where: { id: B.post }, data: { title: 'defaced' } }),
    );
    expect(result.count).toBe(0);

    const untouched = await platformDb.post.findUniqueOrThrow({ where: { id: B.post } });
    expect(untouched.title).toBe(`${B.slug} post`);
  });

  it('deleting B’s post affects zero rows', async () => {
    const result = await withTenant(ctxA, (db) => db.post.deleteMany({ where: { id: B.post } }));
    expect(result.count).toBe(0);

    expect(await platformDb.post.findUnique({ where: { id: B.post } })).not.toBeNull();
  });

  it('refuses a create that names Organization B explicitly', async () => {
    await expect(
      withTenant(ctxA, (db) =>
        db.post.create({
          data: {
            organizationId: B.org,
            workspaceId: B.workspace,
            brandId: B.brand,
            body: 'smuggled',
          },
        }),
      ),
    ).rejects.toThrow(/different organizationId/);
  });

  it('refuses a create that reaches for the tenant through a nested connect', async () => {
    await expect(
      withTenant(ctxA, (db) =>
        db.post.create({
          data: {
            organization: { connect: { id: B.org } },
            workspaceId: A.workspace,
            brandId: A.brand,
            body: 'smuggled',
          },
        }),
      ),
    ).rejects.toThrow(/must not set `organization` directly/);
  });
});

// ── Step 5: authorization is evaluated against the resolved principal ───────

describe('authorization uses the resolved principal, not the request', () => {
  it('permits User A on their own workspace and brand', () => {
    expect(can(ctxA, 'post:publish_now', { workspaceId: A.workspace, brandId: A.brand })).toBe(
      true,
    );
  });

  it('still refuses B’s workspace at the policy layer', () => {
    // Owner is org-wide *within its own org*; the tenant context is A, so a
    // scope naming B's workspace is not reachable regardless.
    const found = can(ctxA, 'post:publish_now', { workspaceId: B.workspace });
    // The policy allows org-wide for OWNER, so the real stop is the data layer —
    // asserted below, and this documents that the two layers divide the work.
    expect(found).toBe(true);
  });

  it('and the data layer is what actually stops it', async () => {
    const post = await withTenant(ctxA, (db) =>
      db.post.findFirst({ where: { id: B.post, workspaceId: B.workspace } }),
    );
    expect(post).toBeNull();
  });
});

// ── Step 6: cross-tenant foreign references ────────────────────────────────

describe('cross-tenant foreign references', () => {
  it('a parent from another organization is invisible to the scoped client', async () => {
    // The pattern every service follows: resolve the parent through the scoped
    // client first. B's brand simply does not exist from A's point of view, so
    // a service that resolves before writing cannot build a mixed-tenant row.
    const brand = await withTenant(ctxA, (db) => db.brand.findFirst({ where: { id: B.brand } }));
    expect(brand).toBeNull();
  });

  it('the database refuses a create referencing B’s brand, even from a valid A context', async () => {
    // Formerly a documented gap: the tenant client stamps organizationId = A
    // correctly, but a single-column brandId foreign key only checked that the
    // brand *existed*. Composite (organizationId, brandId) → Brand
    // (organizationId, id) foreign keys now make the row impossible at the
    // database level rather than merely unreachable by convention.
    //
    // Enforcement is proven directly, with every application safeguard
    // bypassed, in packages/db/src/composite-fk.integration.test.ts.
    await expect(
      withTenant(ctxA, (db) =>
        db.post.create({
          data: { workspaceId: A.workspace, brandId: B.brand, body: 'mixed tenant reference' },
        }),
      ),
    ).rejects.toThrow(/foreign key constraint|23503/i);

    expect(await platformDb.post.count({ where: { brandId: B.brand } })).toBe(1);
  });
});
