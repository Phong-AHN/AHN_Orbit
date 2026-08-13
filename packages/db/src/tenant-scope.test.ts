import { describe, expect, it } from 'vitest';
import { TenantIsolationError } from '@orbit/core';
import { applyTenantScope } from './tenant-scope.js';

const ORG = '018f0000-0000-7000-8000-000000000001';
const OTHER_ORG = '018f0000-0000-7000-8000-000000000002';
const tenantModels = new Set(['Post', 'Brand', 'PostVariant']);

const scope = (operation: string, args: unknown, model = 'Post') =>
  applyTenantScope({ model, operation, args, organizationId: ORG, tenantModels });

describe('applyTenantScope — reads', () => {
  it('narrows a findMany with no where at all', () => {
    expect(scope('findMany', undefined)).toEqual({ where: { organizationId: ORG } });
  });

  it('merges the tenant filter as a sibling key', () => {
    expect(scope('findMany', { where: { status: 'DRAFT' } })).toEqual({
      where: { status: 'DRAFT', organizationId: ORG },
    });
  });

  it('cannot be widened by a caller-supplied OR', () => {
    const result = scope('findMany', {
      where: { OR: [{ status: 'DRAFT' }, { status: 'PUBLISHED' }] },
    }) as { where: Record<string, unknown> };

    // Prisma ANDs top-level keys, so the OR is evaluated *within* the tenant.
    expect(result.where.OR).toHaveLength(2);
    expect(result.where.organizationId).toBe(ORG);
  });

  it('preserves select, include, orderBy and pagination', () => {
    const result = scope('findMany', {
      where: { status: 'DRAFT' },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
      cursor: { id: 'x' },
    }) as Record<string, unknown>;

    expect(result.select).toEqual({ id: true });
    expect(result.orderBy).toEqual({ createdAt: 'desc' });
    expect(result.take).toBe(10);
    expect(result.cursor).toEqual({ id: 'x' });
  });

  it('rejects a where that names a different organization', () => {
    expect(() => scope('findMany', { where: { organizationId: OTHER_ORG } })).toThrow(
      TenantIsolationError,
    );
  });

  it('accepts a where that names the same organization', () => {
    expect(() => scope('findMany', { where: { organizationId: ORG } })).not.toThrow();
  });

  it.each(['findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy'])(
    'narrows %s',
    (operation) => {
      const result = scope(operation, { where: { id: 'a' } }) as {
        where: Record<string, unknown>;
      };
      expect(result.where.organizationId).toBe(ORG);
      expect(result.where.id).toBe('a');
    },
  );
});

describe('applyTenantScope — writes', () => {
  it('stamps the tenant onto a create', () => {
    expect(scope('create', { data: { title: 'Hello' } })).toEqual({
      data: { title: 'Hello', organizationId: ORG },
    });
  });

  it('stamps the tenant onto every row of a createMany', () => {
    expect(scope('createMany', { data: [{ title: 'a' }, { title: 'b' }] })).toEqual({
      data: [
        { title: 'a', organizationId: ORG },
        { title: 'b', organizationId: ORG },
      ],
    });
  });

  it('rejects a create that names a different organization', () => {
    expect(() => scope('create', { data: { organizationId: OTHER_ORG } })).toThrow(
      TenantIsolationError,
    );
  });

  it('rejects a nested organization connect that would set the tenant behind our back', () => {
    expect(() =>
      scope('create', { data: { organization: { connect: { id: OTHER_ORG } } } }),
    ).toThrow(/must not set `organization` directly/);
  });

  it.each(['update', 'updateMany', 'delete', 'deleteMany'])('narrows %s', (operation) => {
    // Sibling merge matters here: update/delete need a unique field at the top
    // level, and Prisma rejects an AND wrapper in that position.
    const result = scope(operation, { where: { id: 'a' } }) as {
      where: Record<string, unknown>;
    };
    expect(result.where).toEqual({ id: 'a', organizationId: ORG });
  });

  it('refuses update and delete with no where rather than issuing an unbounded statement', () => {
    expect(() => scope('update', {})).toThrow(TenantIsolationError);
    expect(() => scope('delete', {})).toThrow(TenantIsolationError);
  });
});

describe('applyTenantScope — the tenant root', () => {
  const root = (operation: string, args: unknown) =>
    applyTenantScope({
      model: 'Organization',
      operation,
      args,
      organizationId: ORG,
      tenantModels,
      tenantRootModel: 'Organization',
    });

  it('scopes the root by its own id, since it has no organizationId column', () => {
    expect(root('findMany', undefined)).toEqual({ where: { id: ORG } });
  });

  it('merges the identity filter as a sibling key', () => {
    expect(root('findFirst', { where: { slug: 'acme' } })).toEqual({
      where: { slug: 'acme', id: ORG },
    });
  });

  it('refuses a lookup for a different organization by id', () => {
    expect(() => root('findFirst', { where: { id: OTHER_ORG } })).toThrow(TenantIsolationError);
  });

  it('does not resolve another organization even by exact id', () => {
    // The regression this guards: Organization carries no organizationId, so it
    // is absent from tenantModels and would otherwise pass through unscoped.
    const scoped = root('findFirst', { where: { slug: 'other-tenant' } }) as {
      where: Record<string, unknown>;
    };
    expect(scoped.where.id).toBe(ORG);
  });

  it('refuses creating or deleting an organization through a tenant client', () => {
    expect(() => root('create', { data: { name: 'New Org' } })).toThrow(/platform operation/);
    expect(() => root('createMany', { data: [{ name: 'x' }] })).toThrow(/platform operation/);
  });

  it('refuses findUnique on the root as well', () => {
    expect(() => root('findUnique', { where: { id: ORG } })).toThrow(/findFirst/);
  });
});

describe('applyTenantScope — refusals', () => {
  it.each([
    ['findUnique', /findFirst/],
    ['findUniqueOrThrow', /findFirstOrThrow/],
    ['upsert', /findFirst \+ create\/update/],
  ])('refuses %s and names the safe alternative', (operation, hint) => {
    expect(() => scope(operation, { where: { id: 'a' } })).toThrow(hint);
  });

  it('fails closed on an operation it does not recognise', () => {
    expect(() => scope('someFutureOperation', {})).toThrow(/cannot be tenant-scoped/);
  });

  it('leaves non-tenant models completely alone', () => {
    const args = { where: { firebaseUid: 'abc' } };
    expect(
      applyTenantScope({
        model: 'User',
        operation: 'findUnique',
        args,
        organizationId: ORG,
        tenantModels,
      }),
    ).toBe(args);
  });
});
