import { PrismaClient } from '@prisma/client';
import { serverEnv } from '@orbit/config';

/**
 * The base Prisma client.
 *
 * Deliberately NOT exported from the package index. Application code cannot
 * obtain an unscoped client — `withTenant()` is the only way in, which is what
 * makes tenant isolation structurally hard to forget rather than a convention
 * (decision D-005).
 *
 * The one legitimate unscoped surface is `platformDb`, for the handful of
 * operations that genuinely precede a tenant: resolving a user by Firebase uid,
 * accepting an invitation, recording a webhook.
 */

const globalForPrisma = globalThis as unknown as { __orbitPrisma?: PrismaClient };

function create(): PrismaClient {
  const env = serverEnv();
  return new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    // Query events are emitted outside production, never printed: `emit: 'event'`
    // means nothing reaches stdout unless something subscribes. Development uses
    // it for tracing, and integration tests use it to assert that an aggregation
    // is a fixed number of queries rather than one per row (T1.17) — a property
    // that is otherwise unobservable, since Prisma 6 removed `$use` and
    // `$extends` returns a new client rather than instrumenting this one.
    log:
      env.NODE_ENV === 'production'
        ? ['warn', 'error']
        : [{ emit: 'event', level: 'query' }, 'warn', 'error'],
  });
}

/**
 * Reused across hot reloads in development so a watch cycle does not open a new
 * connection pool every time a file changes.
 */
export const basePrisma: PrismaClient = globalForPrisma.__orbitPrisma ?? create();

if (serverEnv().NODE_ENV !== 'production') {
  globalForPrisma.__orbitPrisma = basePrisma;
}

/**
 * Unscoped access, for the narrow set of operations that happen before a tenant
 * is known. Every call site must be obvious about why it is safe.
 */
export const platformDb = basePrisma;

export async function disconnect(): Promise<void> {
  await basePrisma.$disconnect();
}
