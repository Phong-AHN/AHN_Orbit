import type { MembershipStatus, OrganizationRole, WorkspaceRole } from './enums.js';

/**
 * Tenant context — resolved once per request (or once per job) and threaded
 * through every layer beneath it (docs/ARCHITECTURE.md §1.3).
 *
 * A tenant-scoped Prisma client is only constructible from one of these, which
 * is what makes SRS §4's server-side isolation structurally hard to forget
 * rather than a convention people have to remember.
 */

export interface WorkspaceGrant {
  workspaceId: string;
  role: WorkspaceRole;
}

/** Optional narrowing below workspace level. Only ever narrows, never widens. */
export interface BrandGrant {
  brandId: string;
  canApprove: boolean;
}

export interface UserPrincipal {
  kind: 'USER';
  userId: string;
  email: string;
  /** Operational access to the platform itself — never tenant content (§28). */
  isPlatformAdmin: boolean;
  organizationRole: OrganizationRole;
  membershipStatus: MembershipStatus;
  workspaces: readonly WorkspaceGrant[];
  brands: readonly BrandGrant[];
}

/**
 * Background jobs and webhooks act with an explicit, minimal capability set —
 * never "root" (docs/RBAC.md §6). A publish worker can transition publish
 * states and nothing else.
 */
export interface SystemPrincipal {
  kind: 'SYSTEM';
  /** Job or handler name, for the audit trail. */
  actorName: string;
  capabilities: readonly string[];
}

export type Principal = UserPrincipal | SystemPrincipal;

export interface TenantContext {
  organizationId: string;
  principal: Principal;
  correlationId: string;
}

export function isUserPrincipal(p: Principal): p is UserPrincipal {
  return p.kind === 'USER';
}

export function isSystemPrincipal(p: Principal): p is SystemPrincipal {
  return p.kind === 'SYSTEM';
}

export function actorUserId(ctx: TenantContext): string | null {
  return isUserPrincipal(ctx.principal) ? ctx.principal.userId : null;
}

export function actorLabel(ctx: TenantContext): string {
  return isUserPrincipal(ctx.principal)
    ? `user:${ctx.principal.userId}`
    : `system:${ctx.principal.actorName}`;
}

export function workspaceGrant(
  ctx: TenantContext,
  workspaceId: string,
): WorkspaceGrant | undefined {
  if (!isUserPrincipal(ctx.principal)) return undefined;
  return ctx.principal.workspaces.find((w) => w.workspaceId === workspaceId);
}

export function brandGrant(ctx: TenantContext, brandId: string): BrandGrant | undefined {
  if (!isUserPrincipal(ctx.principal)) return undefined;
  return ctx.principal.brands.find((b) => b.brandId === brandId);
}

/** Workspace ids a principal can reach at all. Owners/Admins are org-wide. */
export function accessibleWorkspaceIds(ctx: TenantContext): 'ALL' | readonly string[] {
  const p = ctx.principal;
  if (p.kind === 'SYSTEM') return 'ALL';
  if (p.organizationRole === 'OWNER' || p.organizationRole === 'ADMIN') return 'ALL';
  return p.workspaces.map((w) => w.workspaceId);
}
