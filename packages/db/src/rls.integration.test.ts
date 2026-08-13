import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

/**
 * Proves the RLS backstop (decision D-005, migration 20260811000200).
 *
 * These tests connect as `orbit_app` — a NON-OWNER — because Postgres exempts a
 * table's owner from its policies. A test that connected as the owner would
 * pass while proving nothing.
 *
 * The application-layer guard is deliberately not involved here: this asserts
 * what the database does on its own if that guard is ever bypassed.
 */

const OWNER_URL =
  process.env.DATABASE_URL ??
  'postgresql://orbit:orbit_local_dev@localhost:5432/orbit?schema=public';
const APP_URL = OWNER_URL.replace('orbit:orbit_local_dev@', 'orbit_app:orbit_local_dev@');

const ORG_A = '018fAAAA-0000-7000-8000-00000000000a'.toLowerCase();
const ORG_B = '018fBBBB-0000-7000-8000-00000000000b'.toLowerCase();

const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
const app = new PrismaClient({ datasources: { db: { url: APP_URL } } });

/** Run a callback with the tenant setting armed, exactly as withTenant() does. */
async function asTenant<T>(orgId: string | null, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    if (orgId) {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}::text, true)`;
    }
    return fn(tx as unknown as PrismaClient);
  }) as Promise<T>;
}

beforeAll(async () => {
  for (const [id, slug, name] of [
    [ORG_A, 'rls-test-a', 'RLS Test A'],
    [ORG_B, 'rls-test-b', 'RLS Test B'],
  ] as const) {
    await owner.organization.upsert({
      where: { id },
      update: {},
      create: { id, name, slug, timezone: 'UTC' },
    });
    await owner.workspace.upsert({
      where: { organizationId_slug: { organizationId: id, slug: 'main' } },
      update: {},
      create: { organizationId: id, name: `${name} Workspace`, slug: 'main', timezone: 'UTC' },
    });
  }
});

afterAll(async () => {
  await owner.organization.deleteMany({ where: { id: { in: [ORG_A, ORG_B] } } });
  await owner.$disconnect();
  await app.$disconnect();
});

describe('row-level security', () => {
  it('returns nothing at all when no tenant is set — deny by default', async () => {
    const rows = await asTenant(null, (tx) => tx.workspace.findMany());
    expect(rows).toEqual([]);
  });

  it('returns only the current tenant’s rows', async () => {
    const a = await asTenant(ORG_A, (tx) => tx.workspace.findMany());
    const b = await asTenant(ORG_B, (tx) => tx.workspace.findMany());

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.organizationId).toBe(ORG_A);
    expect(b[0]!.organizationId).toBe(ORG_B);
  });

  it('hides another tenant’s row even when its exact id is supplied', async () => {
    const bWorkspace = await owner.workspace.findFirstOrThrow({
      where: { organizationId: ORG_B },
    });

    const found = await asTenant(ORG_A, (tx) =>
      tx.workspace.findFirst({ where: { id: bWorkspace.id } }),
    );

    expect(found).toBeNull();
  });

  it('refuses a write that claims another tenant (WITH CHECK)', async () => {
    await expect(
      asTenant(ORG_A, (tx) =>
        tx.workspace.create({
          data: { organizationId: ORG_B, name: 'Smuggled', slug: 'smuggled', timezone: 'UTC' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses an update that would move a row into another tenant', async () => {
    const aWorkspace = await owner.workspace.findFirstOrThrow({
      where: { organizationId: ORG_A },
    });

    await expect(
      asTenant(ORG_A, (tx) =>
        tx.workspace.update({
          where: { id: aWorkspace.id },
          data: { organizationId: ORG_B },
        }),
      ),
    ).rejects.toThrow();
  });

  it('silently affects zero rows when updating across the boundary', async () => {
    const result = await asTenant(ORG_A, (tx) =>
      tx.workspace.updateMany({
        where: { organizationId: ORG_B },
        data: { name: 'Renamed by the wrong tenant' },
      }),
    );

    expect(result.count).toBe(0);
  });

  it('scopes the tenant root itself by its own id', async () => {
    const orgs = await asTenant(ORG_A, (tx) => tx.organization.findMany());
    expect(orgs.map((o) => o.id)).toEqual([ORG_A]);
  });

  it('resets the setting between transactions so a pooled connection cannot leak it', async () => {
    await asTenant(ORG_A, (tx) => tx.workspace.findMany());
    // A fresh transaction with no SET LOCAL must see nothing, even though the
    // previous one on the same pooled connection was scoped to ORG_A.
    const rows = await asTenant(null, (tx) => tx.workspace.findMany());
    expect(rows).toEqual([]);
  });
});

describe('append-only audit log', () => {
  it('permits inserts', async () => {
    const created = await asTenant(ORG_A, (tx) =>
      tx.auditLog.create({
        data: {
          organizationId: ORG_A,
          actorType: 'SYSTEM',
          action: 'test.write',
          resourceType: 'Workspace',
        },
      }),
    );
    expect(created.id).toBeTruthy();
  });

  it('denies updates and deletes to the application role', async () => {
    const row = await owner.auditLog.findFirstOrThrow({ where: { organizationId: ORG_A } });

    await expect(
      asTenant(ORG_A, (tx) =>
        tx.auditLog.update({ where: { id: row.id }, data: { action: 'tampered' } }),
      ),
    ).rejects.toThrow();

    await expect(
      asTenant(ORG_A, (tx) => tx.auditLog.deleteMany({ where: { id: row.id } })),
    ).rejects.toThrow();
  });
});
