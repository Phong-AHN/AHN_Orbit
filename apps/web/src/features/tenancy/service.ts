import {
  ConflictError,
  NotFoundError,
  PlanLimitExceededError,
  clock,
  type TenantContext,
} from '@orbit/core';
import { platformDb, withTenant, type TenantDb } from '@orbit/db';
import { audit, type AuditInput } from '@/server/audit';
import { uniqueSlug } from '@/server/slug';
import type { CreateBrandInput, CreateOrganizationInput, CreateWorkspaceInput } from './contracts';

/**
 * Tenancy services (T1.4).
 *
 * Every function here takes an already-resolved `TenantContext`, so
 * authentication, tenant resolution and authorization have all happened before
 * a single query runs. Reads and writes go through `withTenant`, which is
 * tenant-scoped and RLS-armed; `platformDb` appears only in
 * `createOrganization`, which by definition precedes any tenant.
 */

/**
 * Plan limits, stored as jsonb. Declared as an index-signature type so it
 * satisfies Prisma's `InputJsonValue` while staying readable at the call site.
 */
interface PlanLimits {
  workspaces?: number;
  socialAccounts?: number;
  aiCreditsPerMonth?: number;
  storageBytes?: number;
  [key: string]: number | undefined;
}

const DEFAULT_TRIAL_LIMITS: PlanLimits = {
  workspaces: 3,
  socialAccounts: 5,
  aiCreditsPerMonth: 500,
  storageBytes: 5 * 1024 ** 3,
};

async function planLimits(db: TenantDb): Promise<PlanLimits> {
  const subscription = await db.subscription.findFirst({ select: { limits: true } });
  return (subscription?.limits as PlanLimits | undefined) ?? DEFAULT_TRIAL_LIMITS;
}

// ── Organizations ───────────────────────────────────────────────────────────

/**
 * Create an organization and make the caller its Owner.
 *
 * The only operation in this file that touches `platformDb`: there is no tenant
 * to scope to until the row exists. Everything is one transaction, so a failure
 * cannot leave an organization with no owner — which would be unrecoverable
 * without support intervention.
 */
export async function createOrganization(
  userId: string,
  input: CreateOrganizationInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
  correlationId: string,
) {
  const slug = await uniqueSlug(
    input.name,
    async (candidate) => (await platformDb.organization.count({ where: { slug: candidate } })) > 0,
    'organization',
  );

  return platformDb.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: input.name,
        slug,
        timezone: input.timezone,
        memberships: {
          create: { userId, role: 'OWNER', status: 'ACTIVE', acceptedAt: clock.now() },
        },
        subscription: {
          create: { plan: 'trial', status: 'TRIALING', seats: 5, limits: DEFAULT_TRIAL_LIMITS },
        },
      },
      select: { id: true, name: true, slug: true, timezone: true, createdAt: true },
    });

    await tx.auditLog.create({
      data: {
        organizationId: organization.id,
        actorUserId: userId,
        actorType: 'USER',
        action: 'organization.created',
        resourceType: 'Organization',
        resourceId: organization.id,
        after: { name: organization.name, slug: organization.slug },
        correlationId,
        ip: fingerprint.ip ?? null,
        userAgent: fingerprint.userAgent ?? null,
      },
    });

    return organization;
  });
}

export async function getOrganization(ctx: TenantContext) {
  return withTenant(ctx, async (db) => {
    const organization = await db.organization.findFirst({
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        logoUrl: true,
        createdAt: true,
      },
    });
    if (!organization) throw new NotFoundError('Organization');

    const [workspaceCount, memberCount, subscription] = await Promise.all([
      db.workspace.count({ where: { deletedAt: null } }),
      db.organizationMembership.count({ where: { status: 'ACTIVE' } }),
      db.subscription.findFirst({
        select: { plan: true, status: true, seats: true, limits: true, currentPeriodEnd: true },
      }),
    ]);

    return {
      ...organization,
      counts: { workspaces: workspaceCount, members: memberCount },
      subscription,
    };
  });
}

export async function updateOrganization(
  ctx: TenantContext,
  patch: { name?: string; timezone?: string; logoUrl?: string | undefined },
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const before = await db.organization.findFirst({
      select: { name: true, timezone: true, logoUrl: true },
    });
    if (!before) throw new NotFoundError('Organization');

    const updated = await db.organization.update({
      where: { id: ctx.organizationId },
      data: patch,
      select: { id: true, name: true, slug: true, timezone: true, logoUrl: true },
    });

    await audit(db, ctx, {
      action: 'organization.updated',
      resourceType: 'Organization',
      resourceId: ctx.organizationId,
      before,
      after: patch,
      ...fingerprint,
    });

    return updated;
  });
}

// ── Workspaces ──────────────────────────────────────────────────────────────

export async function listWorkspaces(ctx: TenantContext, accessible: 'ALL' | readonly string[]) {
  return withTenant(ctx, (db) =>
    db.workspace.findMany({
      where: {
        deletedAt: null,
        ...(accessible === 'ALL' ? {} : { id: { in: [...accessible] } }),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        status: true,
        clientCompanyName: true,
        _count: { select: { brands: { where: { deletedAt: null } } } },
      },
      orderBy: { name: 'asc' },
    }),
  );
}

/**
 * Workspaces with their brands and how many accounts each brand can publish to.
 *
 * Powers the setup page, which has to show the whole chain at once — a brand
 * with no connected account is the single most common reason a new agency
 * cannot post, and a count of brands would not reveal it. Two queries whatever
 * the row count (Prisma batches the nested select), not one per workspace.
 *
 * `listWorkspaces` is left alone: it backs the workspaces API, and widening a
 * response shape for one page's benefit is how endpoints start returning things
 * nobody asked for.
 */
export async function listWorkspacesWithBrands(
  ctx: TenantContext,
  accessible: 'ALL' | readonly string[],
) {
  return withTenant(ctx, (db) =>
    db.workspace.findMany({
      where: {
        deletedAt: null,
        ...(accessible === 'ALL' ? {} : { id: { in: [...accessible] } }),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        status: true,
        clientCompanyName: true,
        brands: {
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            slug: true,
            primaryColor: true,
            // Staged rows mid-OAuth are DISABLED and are not connections
            // anybody has made yet, so they must not read as ready.
            _count: {
              select: {
                socialAccounts: { where: { deletedAt: null, status: { not: 'DISABLED' } } },
              },
            },
          },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
    }),
  );
}

export async function createWorkspace(
  ctx: TenantContext,
  input: CreateWorkspaceInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const limits = await planLimits(db);
    if (limits.workspaces !== undefined) {
      const existing = await db.workspace.count({ where: { deletedAt: null } });
      if (existing >= limits.workspaces) {
        throw new PlanLimitExceededError('Workspace limit reached', {
          userMessage: `Your plan includes ${limits.workspaces} client workspaces. Upgrade to add more.`,
          context: { limit: limits.workspaces, existing },
        });
      }
    }

    const slug = await uniqueSlug(
      input.name,
      async (candidate) => (await db.workspace.count({ where: { slug: candidate } })) > 0,
      'workspace',
    );

    const workspace = await db.workspace.create({
      data: {
        // Explicit for the types; verified, not trusted, by applyTenantScope.
        organizationId: ctx.organizationId,
        name: input.name,
        slug,
        timezone: input.timezone,
        clientCompanyName: input.clientCompanyName ?? null,
      },
      select: { id: true, name: true, slug: true, timezone: true, status: true },
    });

    await audit(db, ctx, {
      action: 'workspace.created',
      resourceType: 'Workspace',
      resourceId: workspace.id,
      workspaceId: workspace.id,
      after: { name: workspace.name, slug: workspace.slug, timezone: workspace.timezone },
      ...fingerprint,
    });

    return workspace;
  });
}

/** Resolve one workspace, or 404. Scoped, so another tenant's id simply is not found. */
export async function getWorkspace(ctx: TenantContext, workspaceId: string) {
  return withTenant(ctx, async (db) => {
    const workspace = await db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        status: true,
        clientCompanyName: true,
        clientUploadsEnabled: true,
        brands: {
          where: { deletedAt: null },
          select: { id: true, name: true, slug: true, logoUrl: true },
          orderBy: { name: 'asc' },
        },
      },
    });

    if (!workspace) throw new NotFoundError('Workspace');
    return workspace;
  });
}

export async function updateWorkspace(
  ctx: TenantContext,
  workspaceId: string,
  patch: Record<string, unknown>,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const before = await db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { name: true, timezone: true, status: true, clientUploadsEnabled: true },
    });
    if (!before) throw new NotFoundError('Workspace');

    const updated = await db.workspace.update({
      where: { id: workspaceId },
      data: patch,
      select: { id: true, name: true, slug: true, timezone: true, status: true },
    });

    await audit(db, ctx, {
      action: 'workspace.updated',
      resourceType: 'Workspace',
      resourceId: workspaceId,
      workspaceId,
      before,
      after: patch,
      ...fingerprint,
    });

    return updated;
  });
}

/** Soft delete (assumption C12). Descendants are hidden by the same flag. */
export async function deleteWorkspace(
  ctx: TenantContext,
  workspaceId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const workspace = await db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!workspace) throw new NotFoundError('Workspace');

    const now = clock.now();
    await db.workspace.update({ where: { id: workspaceId }, data: { deletedAt: now } });
    await db.brand.updateMany({ where: { workspaceId }, data: { deletedAt: now } });

    await audit(db, ctx, {
      action: 'workspace.deleted',
      resourceType: 'Workspace',
      resourceId: workspaceId,
      workspaceId,
      before: { name: workspace.name },
      ...fingerprint,
    });
  });
}

// ── Brands ──────────────────────────────────────────────────────────────────

export async function createBrand(
  ctx: TenantContext,
  workspaceId: string,
  input: CreateBrandInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    // Resolve the parent through the scoped client first. A workspace in
    // another organization is simply not found here — and the composite
    // foreign key would refuse the row even if this check were skipped
    // (decision D-015).
    const workspace = await db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!workspace) throw new NotFoundError('Workspace');

    const slug = await uniqueSlug(
      input.name,
      async (candidate) => (await db.brand.count({ where: { workspaceId, slug: candidate } })) > 0,
      'brand',
    );

    const brand = await db.brand.create({
      data: {
        organizationId: ctx.organizationId,
        workspaceId,
        name: input.name,
        slug,
        website: input.website ?? null,
        primaryColor: input.primaryColor ?? null,
      },
      select: { id: true, name: true, slug: true, website: true, primaryColor: true },
    });

    await audit(db, ctx, {
      action: 'brand.created',
      resourceType: 'Brand',
      resourceId: brand.id,
      workspaceId,
      brandId: brand.id,
      after: { name: brand.name, slug: brand.slug },
      ...fingerprint,
    });

    return brand;
  });
}

export async function getBrand(ctx: TenantContext, brandId: string) {
  return withTenant(ctx, async (db) => {
    const brand = await db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        website: true,
        logoUrl: true,
        primaryColor: true,
        workspaceId: true,
        workspace: { select: { id: true, name: true, slug: true, timezone: true } },
      },
    });
    if (!brand) throw new NotFoundError('Brand');
    return brand;
  });
}

export async function updateBrand(
  ctx: TenantContext,
  brandId: string,
  patch: Record<string, unknown>,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const before = await db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { name: true, website: true, primaryColor: true, workspaceId: true },
    });
    if (!before) throw new NotFoundError('Brand');

    const updated = await db.brand.update({
      where: { id: brandId },
      data: patch,
      select: { id: true, name: true, slug: true, website: true, primaryColor: true },
    });

    await audit(db, ctx, {
      action: 'brand.updated',
      resourceType: 'Brand',
      resourceId: brandId,
      workspaceId: before.workspaceId,
      brandId,
      before,
      after: patch,
      ...fingerprint,
    });

    return updated;
  });
}

export async function deleteBrand(
  ctx: TenantContext,
  brandId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  return withTenant(ctx, async (db) => {
    const brand = await db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { id: true, name: true, workspaceId: true },
    });
    if (!brand) throw new NotFoundError('Brand');

    const connected = await db.socialAccount.count({ where: { brandId, deletedAt: null } });
    if (connected > 0) {
      throw new ConflictError('Brand still has connected social accounts', {
        userMessage:
          'Disconnect this brand’s social accounts before deleting it, so nothing is left publishing.',
        context: { brandId, connected },
      });
    }

    await db.brand.update({ where: { id: brandId }, data: { deletedAt: clock.now() } });

    await audit(db, ctx, {
      action: 'brand.deleted',
      resourceType: 'Brand',
      resourceId: brandId,
      workspaceId: brand.workspaceId,
      brandId,
      before: { name: brand.name },
      ...fingerprint,
    });
  });
}
