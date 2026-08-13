import {
  ForbiddenError,
  isEditLocked,
  isUserPrincipal,
  type PostStatus,
  type TenantContext,
} from '@orbit/core';
import { PLATFORM_PERMISSIONS, UNGRANTABLE_PERMISSIONS, type Permission } from './permissions.js';
import { PLATFORM_ADMIN_GRANTS, ROLE_GRANTS, type Grant } from './matrix.js';

/**
 * The single authorization decision point (docs/RBAC.md §6).
 *
 * Frontend, route handlers, server actions, workers, webhooks, and media URL
 * issuance all call `can()`. The frontend uses the answer to *hide* controls;
 * the server uses it to *decide*. Frontend checks are never sufficient.
 */

export interface ResourceScope {
  /** Workspace the resource belongs to. Required for WORKSPACE-scoped grants. */
  workspaceId?: string;
  /** Brand the resource belongs to. Required for BRAND-scoped grants. */
  brandId?: string;
  /** Who created it. Required for OWN-scoped grants. */
  createdById?: string | null;
  /** Current post status, for status-restricted grants. */
  status?: PostStatus;
  /**
   * What the principal is trying to do with the resource in that status.
   *
   * `EDIT` (the default) means mutating content, and the edit lock applies:
   * approved content is frozen. `TRANSITION` means moving the post between
   * statuses, where the lock must *not* apply — the reopen transitions
   * (APPROVED → DRAFT, SCHEDULED → DRAFT) exist precisely to get past it, and
   * gating them on an editable source status would make them unreachable for
   * everyone, including an Owner.
   *
   * This does not weaken the lock. Only `assertTransitionAllowed` sets it, and
   * it does so *after* the state machine has confirmed the transition exists —
   * so the reachable set from a locked status is still exactly what the
   * transition table permits, and content mutation still goes through `EDIT`.
   */
  intent?: 'EDIT' | 'TRANSITION';
}

export type DenialReason =
  | 'NO_GRANT'
  | 'UNGRANTABLE'
  | 'NOT_PLATFORM_ADMIN'
  | 'MEMBERSHIP_INACTIVE'
  | 'OUTSIDE_WORKSPACE'
  | 'OUTSIDE_BRAND'
  | 'NOT_OWNER'
  | 'STATUS_NOT_PERMITTED'
  | 'EDIT_LOCKED'
  | 'NO_APPROVAL_RIGHT'
  | 'MISSING_SCOPE_INFORMATION';

export type Decision =
  | { allowed: true; grant: Grant | 'PLATFORM' | 'SYSTEM' }
  | { allowed: false; reason: DenialReason };

const UNGRANTABLE: ReadonlySet<string> = new Set(UNGRANTABLE_PERMISSIONS);
const PLATFORM_ONLY: ReadonlySet<string> = new Set(PLATFORM_PERMISSIONS);

/**
 * Decide, with a reason. `can()` wraps this when only the boolean matters;
 * the reason is what makes a denial debuggable and what the log records.
 */
export function decide(
  ctx: TenantContext,
  permission: Permission,
  resource: ResourceScope = {},
): Decision {
  // Never granted to anyone, at any privilege level.
  if (UNGRANTABLE.has(permission)) {
    return { allowed: false, reason: 'UNGRANTABLE' };
  }

  // Background jobs and webhooks carry an explicit, minimal capability list —
  // never "root" (docs/RBAC.md §6).
  if (!isUserPrincipal(ctx.principal)) {
    return ctx.principal.capabilities.includes(permission)
      ? { allowed: true, grant: 'SYSTEM' }
      : { allowed: false, reason: 'NO_GRANT' };
  }

  const principal = ctx.principal;

  if (PLATFORM_ONLY.has(permission)) {
    return decidePlatform(principal, permission);
  }

  // An invited-but-not-accepted or suspended member has no rights at all.
  if (principal.membershipStatus !== 'ACTIVE') {
    return { allowed: false, reason: 'MEMBERSHIP_INACTIVE' };
  }

  const grant = ROLE_GRANTS[principal.organizationRole][permission];
  if (!grant) return { allowed: false, reason: 'NO_GRANT' };

  if (
    grant.statuses &&
    resource.status !== undefined &&
    !grant.statuses.includes(resource.status)
  ) {
    return { allowed: false, reason: 'STATUS_NOT_PERMITTED' };
  }

  if (
    grant.requiresEditable &&
    resource.intent !== 'TRANSITION' &&
    resource.status !== undefined &&
    isEditLocked(resource.status)
  ) {
    return { allowed: false, reason: 'EDIT_LOCKED' };
  }

  const orgWide = principal.organizationRole === 'OWNER' || principal.organizationRole === 'ADMIN';

  switch (grant.scope) {
    case 'ORG':
      return { allowed: true, grant };

    case 'WORKSPACE': {
      if (orgWide) return { allowed: true, grant };
      if (!resource.workspaceId) return { allowed: false, reason: 'MISSING_SCOPE_INFORMATION' };
      const member = principal.workspaces.some((w) => w.workspaceId === resource.workspaceId);
      return member ? { allowed: true, grant } : { allowed: false, reason: 'OUTSIDE_WORKSPACE' };
    }

    case 'BRAND': {
      if (orgWide) return { allowed: true, grant };
      if (!resource.brandId) return { allowed: false, reason: 'MISSING_SCOPE_INFORMATION' };

      const assignment = principal.brands.find((b) => b.brandId === resource.brandId);

      if (assignment) {
        if (grant.requiresApprovalRight && !assignment.canApprove) {
          return { allowed: false, reason: 'NO_APPROVAL_RIGHT' };
        }
        return { allowed: true, grant };
      }

      // No assignment for this brand: workspace membership governs. This is why
      // BrandAssignment can only ever narrow access, never widen it.
      if (!resource.workspaceId) return { allowed: false, reason: 'MISSING_SCOPE_INFORMATION' };
      const inWorkspace = principal.workspaces.some((w) => w.workspaceId === resource.workspaceId);
      if (!inWorkspace) return { allowed: false, reason: 'OUTSIDE_BRAND' };

      if (grant.requiresApprovalRight) {
        // Falling back to workspace membership, only an approving workspace
        // role carries the right.
        const wsRole = principal.workspaces.find(
          (w) => w.workspaceId === resource.workspaceId,
        )?.role;
        const approves =
          wsRole === 'APPROVER' || wsRole === 'MANAGER' || wsRole === 'CLIENT_APPROVER';
        if (!approves) return { allowed: false, reason: 'NO_APPROVAL_RIGHT' };
      }

      return { allowed: true, grant };
    }

    case 'OWN': {
      if (!resource.createdById) return { allowed: false, reason: 'MISSING_SCOPE_INFORMATION' };
      if (resource.createdById !== principal.userId) {
        return { allowed: false, reason: 'NOT_OWNER' };
      }
      // Ownership still does not escape the workspace boundary.
      if (resource.workspaceId && !orgWide) {
        const member = principal.workspaces.some((w) => w.workspaceId === resource.workspaceId);
        if (!member) return { allowed: false, reason: 'OUTSIDE_WORKSPACE' };
      }
      return { allowed: true, grant };
    }

    default: {
      const exhaustive: never = grant.scope;
      throw new Error(`Unhandled grant scope: ${String(exhaustive)}`);
    }
  }
}

export function can(
  ctx: TenantContext,
  permission: Permission,
  resource: ResourceScope = {},
): boolean {
  return decide(ctx, permission, resource).allowed;
}

/**
 * Decide a **platform** permission, which has no tenant (docs/RBAC.md §1 rule 4).
 *
 * Operating the SaaS — browsing jobs, reading dead letters, checking health — is
 * not something a principal does *inside* an organization, so there is no
 * `TenantContext` to hand `decide()`. Rather than fabricate one, this takes the
 * user's platform flag directly. `decide()` routes its own `PLATFORM_ONLY`
 * branch through here, so there is exactly one implementation of the rule.
 *
 * Two properties are load-bearing and both come from `PLATFORM_ADMIN_GRANTS`
 * rather than from the caller:
 *
 *  • the flag alone is not enough — the permission must also be in the grant
 *    list, which is why `admin:impersonate` is a platform permission that no
 *    platform admin actually holds;
 *  • nothing here confers access to tenant *content*. A platform admin who
 *    passes this check still cannot read a post, because `post:read` is not a
 *    platform permission and their principal has no organization role.
 */
export function decidePlatform(
  user: { isPlatformAdmin: boolean },
  permission: Permission,
): Decision {
  if (UNGRANTABLE.has(permission)) return { allowed: false, reason: 'UNGRANTABLE' };

  return user.isPlatformAdmin && PLATFORM_ADMIN_GRANTS.includes(permission)
    ? { allowed: true, grant: 'PLATFORM' }
    : { allowed: false, reason: 'NOT_PLATFORM_ADMIN' };
}

export function canPlatform(user: { isPlatformAdmin: boolean }, permission: Permission): boolean {
  return decidePlatform(user, permission).allowed;
}

/**
 * Throw unless permitted. The thrown error carries the denial reason in its
 * `context` (logged, never rendered), so a 403 in production is diagnosable
 * without telling the caller how the policy is shaped.
 */
export function assertCan(
  ctx: TenantContext,
  permission: Permission,
  resource: ResourceScope = {},
): void {
  const decision = decide(ctx, permission, resource);
  if (decision.allowed) return;

  throw new ForbiddenError(`Permission denied: ${permission}`, {
    context: {
      permission,
      reason: decision.reason,
      organizationId: ctx.organizationId,
      actor: isUserPrincipal(ctx.principal) ? ctx.principal.userId : ctx.principal.actorName,
      role: isUserPrincipal(ctx.principal) ? ctx.principal.organizationRole : 'SYSTEM',
    },
  });
}

/** Every permission a principal holds unconditionally, for `GET /auth/me`. */
export function effectivePermissions(ctx: TenantContext): Permission[] {
  if (!isUserPrincipal(ctx.principal)) return [...ctx.principal.capabilities] as Permission[];
  if (ctx.principal.membershipStatus !== 'ACTIVE') return [];

  const granted = Object.keys(ROLE_GRANTS[ctx.principal.organizationRole]) as Permission[];
  const platform = ctx.principal.isPlatformAdmin ? [...PLATFORM_ADMIN_GRANTS] : [];
  return [...granted, ...platform];
}
