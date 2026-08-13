import { Prisma } from '@prisma/client';
import type { TenantContext } from '@orbit/core';
import { basePrisma } from './client.js';
import { applyTenantScope } from './tenant-scope.js';

/**
 * The tenant-scoped data layer (decision D-005, SRS §4).
 *
 * `withTenant()` is the only way application code reaches the database. It:
 *   1. opens a transaction;
 *   2. sets `app.current_org_id` for that transaction, which arms the RLS
 *      policies (the independent backstop);
 *   3. hands back a client whose every query is narrowed to the tenant.
 *
 * Transaction-scoped rather than connection-scoped because that is what works
 * with PgBouncer in transaction pooling mode — the deployment shape Prisma on
 * serverless requires (risk R5).
 */

/**
 * Models carrying `organizationId`, derived from the generated DMMF rather than
 * hand-listed. A new tenant model is therefore scoped the moment it is added to
 * the schema, with no second place to remember.
 */
export const TENANT_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === 'organizationId'))
    .map((m) => m.name),
);

/** The tenant root is scoped by its own id, so it is handled separately. */
export const TENANT_ROOT_MODEL = 'Organization';

function tenantExtension(organizationId: string) {
  return Prisma.defineExtension({
    name: 'orbit-tenant-scope',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(
            applyTenantScope({
              model,
              operation,
              args,
              organizationId,
              tenantModels: TENANT_MODELS,
              tenantRootModel: TENANT_ROOT_MODEL,
            }) as typeof args,
          );
        },
      },
    },
  });
}

type ExtendedClient = ReturnType<typeof buildScopedClient>;

function buildScopedClient(organizationId: string) {
  return basePrisma.$extends(tenantExtension(organizationId));
}

/**
 * A tenant-scoped transactional client. Every model operation reachable from
 * here is narrowed to one organization.
 */
export type TenantDb = Omit<
  ExtendedClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

export interface WithTenantOptions {
  /** Overall transaction timeout. Publishing claims are short; reports are not. */
  timeoutMs?: number;
  maxWaitMs?: number;
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * Run `fn` against the database as one tenant, inside one transaction.
 *
 * Multi-row mutations are therefore transactional by construction (SRS §35)
 * rather than by remembering to wrap them.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (db: TenantDb) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  const scoped = buildScopedClient(ctx.organizationId);

  return scoped.$transaction(
    async (tx) => {
      // Transaction-local: reset automatically at commit or rollback, so a
      // pooled connection can never carry one tenant's id into another's work.
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ctx.organizationId}::text, true)`;
      return fn(tx as unknown as TenantDb);
    },
    {
      timeout: options.timeoutMs ?? 10_000,
      maxWait: options.maxWaitMs ?? 5_000,
      ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
    },
  );
}

/**
 * Escape hatch for raw SQL that still needs tenant scoping — the atomic publish
 * claim, mainly, which has to be a single UPDATE ... RETURNING to be correct
 * (docs/ARCHITECTURE.md §5.2 layer 2).
 *
 * The caller is responsible for the tenant predicate in the SQL itself; RLS
 * remains armed underneath either way.
 */
export async function withTenantRaw<T>(
  ctx: TenantContext,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  return basePrisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ctx.organizationId}::text, true)`;
      return fn(tx);
    },
    {
      timeout: options.timeoutMs ?? 10_000,
      maxWait: options.maxWaitMs ?? 5_000,
      ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
    },
  );
}
