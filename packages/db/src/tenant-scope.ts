import { TenantIsolationError } from '@orbit/core';

/**
 * Pure scoping logic for the tenant-scoped client.
 *
 * Kept free of Prisma runtime imports so it can be unit-tested with no database
 * and no generated client — which is what lets the isolation rules be verified
 * on every CI run rather than only in integration tests.
 */

export const TENANT_FIELD = 'organizationId';

/** Operations whose `where` must be narrowed to the tenant. */
const FILTERED_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

/** Operations whose `data` must carry the tenant. */
const WRITE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

/**
 * Operations we refuse on tenant models.
 *
 * `findUnique` and `upsert` take a *unique* where-input, which Prisma will not
 * let us add `organizationId` to unless it is part of the unique key. Silently
 * letting them through would mean an id from another tenant resolves — the
 * exact hole this layer exists to close. Rather than special-casing them we ban
 * them and point at the safe equivalent.
 */
const BANNED_OPERATIONS = new Map([
  [
    'findUnique',
    'findFirst({ where: { id, ... } }) — findUnique cannot be tenant-scoped and would resolve ids from other organizations',
  ],
  [
    'findUniqueOrThrow',
    'findFirstOrThrow({ where: { id, ... } }) — findUniqueOrThrow cannot be tenant-scoped',
  ],
  [
    'upsert',
    'an explicit findFirst + create/update inside withTenant() — upsert cannot be tenant-scoped',
  ],
]);

export interface ScopeInput {
  model: string;
  operation: string;
  args: unknown;
  organizationId: string;
  /** Models that carry organizationId, derived from the Prisma DMMF. */
  tenantModels: ReadonlySet<string>;
  /**
   * The tenant root, which is scoped by its own `id` rather than by an
   * `organizationId` column. Without this it would fall outside `tenantModels`
   * — which carries no organizationId by definition — and pass through
   * unscoped, letting one tenant read another organization's record.
   */
  tenantRootModel?: string;
}

type Args = Record<string, unknown>;

/**
 * Narrow one Prisma operation to a single organization.
 *
 * Returns the args to pass through. Throws `TenantIsolationError` when a call
 * cannot be made safe — never returns un-narrowed args for a tenant model.
 */
export function applyTenantScope(input: ScopeInput): unknown {
  const { model, operation, organizationId, tenantModels } = input;

  if (model === input.tenantRootModel) {
    return scopeTenantRoot(model, operation, input.args, organizationId);
  }

  if (!tenantModels.has(model)) return input.args;

  const banned = BANNED_OPERATIONS.get(operation);
  if (banned) {
    throw new TenantIsolationError(`${model}.${operation}() is not tenant-safe. Use ${banned}.`, {
      context: { model, operation },
    });
  }

  const args: Args = isRecord(input.args) ? { ...input.args } : {};

  if (FILTERED_OPERATIONS.has(operation)) {
    args.where = narrowWhere(args.where, organizationId, model, operation);
    return args;
  }

  if (WRITE_OPERATIONS.has(operation)) {
    args.data = stampTenant(args.data, organizationId, model);
    return args;
  }

  // An operation we do not recognise on a tenant model must not pass through
  // unnarrowed — a future Prisma release adding one would otherwise open a hole.
  throw new TenantIsolationError(
    `Unrecognised operation ${model}.${operation}() cannot be tenant-scoped.`,
    { context: { model, operation } },
  );
}

/**
 * Scope the tenant root by its own primary key.
 *
 * Creating or deleting an organization is a platform operation that precedes
 * (or ends) tenancy, so it is refused here — those paths use `platformDb`
 * explicitly and are audited.
 */
function scopeTenantRoot(
  model: string,
  operation: string,
  rawArgs: unknown,
  organizationId: string,
): unknown {
  const banned = BANNED_OPERATIONS.get(operation);
  if (banned) {
    throw new TenantIsolationError(`${model}.${operation}() is not tenant-safe. Use ${banned}.`, {
      context: { model, operation },
    });
  }

  if (WRITE_OPERATIONS.has(operation)) {
    throw new TenantIsolationError(
      `${model}.${operation}() is a platform operation and cannot run through a tenant-scoped client.`,
      { context: { model, operation } },
    );
  }

  if (!FILTERED_OPERATIONS.has(operation)) {
    throw new TenantIsolationError(
      `Unrecognised operation ${model}.${operation}() cannot be tenant-scoped.`,
      { context: { model, operation } },
    );
  }

  const args: Args = isRecord(rawArgs) ? { ...rawArgs } : {};
  const identity = { id: organizationId };

  if (args.where === undefined || args.where === null) {
    args.where = identity;
    return args;
  }

  if (!isRecord(args.where)) {
    throw new TenantIsolationError(`${model}.${operation}() received a non-object where clause.`, {
      context: { model, operation },
    });
  }

  const declared = args.where.id;
  if (declared !== undefined && declared !== organizationId) {
    throw new TenantIsolationError(
      `${model}.${operation}() was called for a different organization than the request's tenant.`,
      { context: { model, operation, declared, expected: organizationId } },
    );
  }

  args.where = { ...args.where, ...identity };
  return args;
}

function narrowWhere(
  where: unknown,
  organizationId: string,
  model: string,
  operation: string,
): Args {
  const tenantFilter = { [TENANT_FIELD]: organizationId };

  if (where === undefined || where === null) {
    if (operation === 'update' || operation === 'delete') {
      // `update`/`delete` require a where; an empty one is a caller bug, but
      // failing closed here is better than issuing an unbounded statement.
      throw new TenantIsolationError(`${model}.${operation}() requires a where clause.`, {
        context: { model, operation },
      });
    }
    return tenantFilter;
  }

  if (!isRecord(where)) {
    throw new TenantIsolationError(`${model}.${operation}() received a non-object where clause.`, {
      context: { model, operation },
    });
  }

  const declared = where[TENANT_FIELD];
  if (declared !== undefined && declared !== organizationId) {
    throw new TenantIsolationError(
      `${model}.${operation}() was called with a different ${TENANT_FIELD} than the request's tenant.`,
      { context: { model, operation, declared, expected: organizationId } },
    );
  }

  // Merged as a sibling key rather than wrapped in AND. Prisma ANDs every
  // top-level key, so `{ OR: [...], organizationId }` still binds the tenant —
  // and unlike an AND wrapper this remains a valid `where` for update/delete,
  // which require a unique field at the top level.
  //
  // Safe because a caller-supplied organizationId that disagrees was already
  // rejected above; it can therefore only ever narrow.
  return { ...where, [TENANT_FIELD]: organizationId };
}

function stampTenant(data: unknown, organizationId: string, model: string): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => stampTenant(row, organizationId, model));
  }

  if (data === undefined || data === null) {
    return { [TENANT_FIELD]: organizationId };
  }

  if (!isRecord(data)) {
    throw new TenantIsolationError(`${model}.create() received a non-object data payload.`, {
      context: { model },
    });
  }

  const declared = data[TENANT_FIELD];
  if (declared !== undefined && declared !== organizationId) {
    throw new TenantIsolationError(
      `${model}.create() was called with a different ${TENANT_FIELD} than the request's tenant.`,
      { context: { model, declared, expected: organizationId } },
    );
  }

  // A nested `organization: { connect: ... }` would set the tenant behind our
  // back, so it is refused outright — the scalar field is the only way in.
  if ('organization' in data) {
    throw new TenantIsolationError(
      `${model}.create() must not set \`organization\` directly; the tenant is supplied by the scoped client.`,
      { context: { model } },
    );
  }

  return { ...data, [TENANT_FIELD]: organizationId };
}

function isRecord(value: unknown): value is Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
