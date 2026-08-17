import type { OrganizationRole, PostStatus } from '@orbit/core';
import type { Permission } from './permissions.js';

/**
 * The grant matrix — an executable transcription of docs/RBAC.md §4.
 *
 * Anything absent is denied. That is the whole safety property: a new
 * permission, or a new role, grants nothing until someone writes it down here.
 */

export type GrantScope =
  /** Anywhere in the organization. */
  | 'ORG'
  /** Only in workspaces the user belongs to. OWNER and ADMIN are org-wide. */
  | 'WORKSPACE'
  /** Only for brands the user is assigned to (workspace membership governs if
   *  the brand has no assignments at all). */
  | 'BRAND'
  /** Only resources the user created. */
  | 'OWN';

export interface Grant {
  scope: GrantScope;
  /**
   * Restricts the grant to resources in these post statuses. This is how the
   * client portal is confined to content that has actually reached them
   * (docs/RBAC.md §4.4).
   */
  statuses?: readonly PostStatus[];
  /** Requires the post to still be editable (before APPROVED). */
  requiresEditable?: boolean;
  /** Requires `BrandAssignment.canApprove` where an assignment exists. */
  requiresApprovalRight?: boolean;
  /** Free-text note carried into docs and test failure output. */
  note?: string;
}

export type RoleGrants = Partial<Record<Permission, Grant>>;

const ORG: Grant = { scope: 'ORG' };
const WS: Grant = { scope: 'WORKSPACE' };
const BRAND: Grant = { scope: 'BRAND' };
const OWN: Grant = { scope: 'OWN' };

/** Statuses a Client may see at all — nothing before it reaches them. */
export const CLIENT_VISIBLE_STATUSES = [
  'CLIENT_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
] as const satisfies readonly PostStatus[];

// ── Organization Owner ───────────────────────────────────────────────────────
// Everything within the organization, including billing, deletion and ownership
// transfer. Still cannot read credentials or reach another tenant.
const OWNER: RoleGrants = {
  'org:read': ORG,
  'org:update': ORG,
  'org:delete': ORG,
  'org:transfer_ownership': ORG,
  'member:invite': ORG,
  'member:list': ORG,
  'member:update_role': ORG,
  'member:remove': ORG,
  'audit:read': ORG,

  'workspace:create': ORG,
  'workspace:read': ORG,
  'workspace:update': ORG,
  'workspace:delete': ORG,
  'workspace:manage_members': ORG,
  'brand:create': ORG,
  'brand:read': ORG,
  'brand:update': ORG,
  'brand:delete': ORG,
  'brand_voice:read': ORG,
  'brand_voice:update': ORG,

  'social_account:connect': ORG,
  'social_account:read': ORG,
  'social_account:reconnect': ORG,
  'social_account:disconnect': ORG,

  'post:create': ORG,
  'post:read': ORG,
  'post:update': { scope: 'ORG', requiresEditable: true },
  'post:delete': ORG,
  'post:assign': ORG,
  'task:create': ORG,
  'task:read': ORG,
  'task:update': ORG,
  'task:delete': ORG,
  'post:submit_internal_review': ORG,
  'post:approve_internal': ORG,
  'post:submit_client_review': ORG,
  'post:approve_client': { scope: 'ORG', note: 'recorded on the client’s behalf; audited' },
  'post:request_changes': ORG,
  'post:schedule': ORG,
  'post:reschedule': ORG,
  'post:publish_now': ORG,
  'post:cancel_scheduled': ORG,
  'post:retry_failed': ORG,
  'post:delete_published_remote': ORG,

  'comment:create': ORG,
  'comment:read_internal': ORG,
  'comment:resolve': ORG,

  'media:upload': ORG,
  'media:read': ORG,
  'media:update': ORG,
  'media:delete': ORG,

  'analytics:read': ORG,
  'report:generate': ORG,
  'report:export': ORG,
  'ai:generate': ORG,
  'ai:view_usage': ORG,

  'billing:read': ORG,
  'billing:manage': ORG,
};

function without(grants: RoleGrants, ...revoked: Permission[]): RoleGrants {
  const copy: RoleGrants = { ...grants };
  for (const permission of revoked) delete copy[permission];
  return copy;
}

// ── Organization Admin ───────────────────────────────────────────────────────
// Runs the agency day to day. Everything the Owner has except the three things
// that should need an owner: deleting the org, handing it over, and paying.
const ADMIN: RoleGrants = without(OWNER, 'org:delete', 'org:transfer_ownership', 'billing:manage');

// ── Account Manager ──────────────────────────────────────────────────────────
// Owns a set of client workspaces end to end.
const ACCOUNT_MANAGER: RoleGrants = {
  'org:read': ORG,
  'member:list': WS,
  'member:invite': { scope: 'WORKSPACE', note: 'client users into their own workspaces only' },
  'audit:read': WS,

  'workspace:read': WS,
  'workspace:update': WS,
  'workspace:manage_members': WS,
  'brand:create': WS,
  'brand:read': WS,
  'brand:update': WS,
  'brand_voice:read': WS,
  'brand_voice:update': WS,

  'social_account:connect': WS,
  'social_account:read': WS,
  'social_account:reconnect': WS,
  'social_account:disconnect': WS,

  'post:create': WS,
  'post:read': WS,
  'post:update': { scope: 'WORKSPACE', requiresEditable: true },
  'post:delete': WS,
  'post:assign': WS,
  'task:create': WS,
  'task:read': WS,
  'task:update': WS,
  'task:delete': WS,
  'post:submit_internal_review': WS,
  'post:approve_internal': WS,
  'post:submit_client_review': WS,
  'post:approve_client': { scope: 'WORKSPACE', note: 'on the client’s behalf; audited' },
  'post:request_changes': WS,
  'post:schedule': WS,
  'post:reschedule': WS,
  'post:publish_now': WS,
  'post:cancel_scheduled': WS,
  'post:retry_failed': WS,
  'post:delete_published_remote': WS,

  'comment:create': WS,
  'comment:read_internal': WS,
  'comment:resolve': WS,

  'media:upload': WS,
  'media:read': WS,
  'media:update': WS,
  'media:delete': WS,

  'analytics:read': WS,
  'report:generate': WS,
  'report:export': WS,
  'ai:generate': WS,
};

// ── Content Creator ──────────────────────────────────────────────────────────
// Produces content. Drafts and submits; never approves, never publishes.
const CONTENT_CREATOR: RoleGrants = {
  'org:read': ORG,
  'member:list': WS,
  'workspace:read': WS,
  'brand:read': BRAND,
  'brand_voice:read': BRAND,
  'social_account:read': WS,

  'post:create': BRAND,
  'post:read': BRAND,
  'post:update': { scope: 'OWN', requiresEditable: true },
  'post:delete': { scope: 'OWN', requiresEditable: true },
  'post:submit_internal_review': OWN,

  'task:read': BRAND,
  // A contributor moves the task they were given; adding or removing stages is
  // a manager's decision about how the work is organised, not their own.
  'task:update': { scope: 'OWN', note: 'tasks assigned to them' },

  'comment:create': BRAND,
  'comment:read_internal': BRAND,
  'comment:resolve': OWN,

  'media:upload': BRAND,
  'media:read': BRAND,
  'media:update': OWN,
  'media:delete': OWN,

  'analytics:read': { scope: 'OWN', note: 'own posts, so creators can learn from results (O3)' },
  'ai:generate': BRAND,
};

// ── Approver ─────────────────────────────────────────────────────────────────
// The internal quality gate. Approves and rejects; publishing is deliberately
// somebody else's job — that separation is the point of an approval workflow.
const APPROVER: RoleGrants = {
  'org:read': ORG,
  'member:list': WS,
  'workspace:read': WS,
  'brand:read': BRAND,
  'brand_voice:read': BRAND,
  'social_account:read': WS,

  'post:read': BRAND,
  'post:approve_internal': { scope: 'BRAND', requiresApprovalRight: true },
  'post:submit_client_review': { scope: 'BRAND', requiresApprovalRight: true },
  'post:request_changes': BRAND,

  'task:read': BRAND,

  'comment:create': BRAND,
  'comment:read_internal': BRAND,
  'comment:resolve': BRAND,

  'media:read': BRAND,
  'analytics:read': WS,
};

// ── Client ───────────────────────────────────────────────────────────────────
// External. Reviews and approves their own content. Sees nothing internal —
// note the absence of comment:read_internal, which is what keeps agency
// chatter out of the portal.
const CLIENT: RoleGrants = {
  'workspace:read': WS,
  'brand:read': BRAND,
  'social_account:read': { scope: 'WORKSPACE', note: 'name and avatar only' },

  'post:read': { scope: 'WORKSPACE', statuses: CLIENT_VISIBLE_STATUSES },
  'post:approve_client': { scope: 'WORKSPACE', statuses: ['CLIENT_REVIEW'] },
  'post:request_changes': { scope: 'WORKSPACE', statuses: ['CLIENT_REVIEW'] },

  'comment:create': { scope: 'WORKSPACE', statuses: CLIENT_VISIBLE_STATUSES },

  'media:read': BRAND,
  'analytics:read': { scope: 'BRAND', statuses: ['PUBLISHED', 'PARTIALLY_PUBLISHED'] },
};

export const ROLE_GRANTS: Record<OrganizationRole, RoleGrants> = {
  OWNER,
  ADMIN,
  ACCOUNT_MANAGER,
  CONTENT_CREATOR,
  APPROVER,
  CLIENT,
};

export interface RolesByReach {
  /** Roles granted this permission organization-wide. */
  orgWide: OrganizationRole[];
  /** Roles granted it only where they hold a workspace or brand membership. */
  workspaceScoped: OrganizationRole[];
}

/**
 * Read the matrix backwards: which roles hold a permission, and how far.
 *
 * The matrix answers "may this role do X?" on every request. This answers the
 * inverse — "who may do X?" — which is what anything addressing people needs:
 * who to notify that an account broke, who to route an approval to, who to list
 * as a possible assignee.
 *
 * Deriving it matters more than it looks. The alternative is a hand-written
 * `['OWNER', 'ADMIN']` at each call site, which is correct on the day it is
 * typed and silently wrong the first time the matrix moves — and wrong in the
 * quiet direction, where someone simply stops being told things.
 *
 * `WORKSPACE`, `BRAND` and `OWN` all collapse to `workspaceScoped`: each means
 * "not everywhere", and the caller narrows with the membership check it can
 * actually make. `OWN` never appears on a people-addressing permission today;
 * grouping it here fails closed if that changes.
 */
export function rolesWithPermission(permission: Permission): RolesByReach {
  const orgWide: OrganizationRole[] = [];
  const workspaceScoped: OrganizationRole[] = [];

  for (const [role, grants] of Object.entries(ROLE_GRANTS) as [OrganizationRole, RoleGrants][]) {
    const grant = grants[permission];
    if (!grant) continue;
    if (grant.scope === 'ORG') orgWide.push(role);
    else workspaceScoped.push(role);
  }

  return { orgWide, workspaceScoped };
}

/**
 * Platform administrators operate the SaaS. They are NOT tenant superusers:
 * this list contains no content permission, by design (docs/RBAC.md §1 rule 4).
 */
export const PLATFORM_ADMIN_GRANTS: readonly Permission[] = [
  'org:suspend',
  'admin:view_jobs',
  'admin:retry_job',
  'admin:view_system_logs',
];
