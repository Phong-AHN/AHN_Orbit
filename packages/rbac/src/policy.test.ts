import { describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  ORGANIZATION_ROLES,
  type OrganizationRole,
  type TenantContext,
  type UserPrincipal,
} from '@orbit/core';
import { PERMISSIONS, UNGRANTABLE_PERMISSIONS, type Permission } from './permissions.js';
import { ROLE_GRANTS } from './matrix.js';
import { assertCan, can, decide, effectivePermissions } from './policy.js';

const ORG = '018f0000-0000-7000-8000-0000000000aa';
const WS_A = '018f0000-0000-7000-8000-0000000000w1';
const WS_B = '018f0000-0000-7000-8000-0000000000w2';
const BRAND_A = '018f0000-0000-7000-8000-0000000000b1';
const USER = '018f0000-0000-7000-8000-0000000000u1';
const OTHER_USER = '018f0000-0000-7000-8000-0000000000u2';

function principal(overrides: Partial<UserPrincipal> = {}): UserPrincipal {
  return {
    kind: 'USER',
    userId: USER,
    email: 'user@ahn.test',
    isPlatformAdmin: false,
    organizationRole: 'ACCOUNT_MANAGER',
    membershipStatus: 'ACTIVE',
    workspaces: [{ workspaceId: WS_A, role: 'MANAGER' }],
    brands: [],
    ...overrides,
  };
}

function ctx(overrides: Partial<UserPrincipal> = {}): TenantContext {
  return {
    organizationId: ORG,
    principal: principal(overrides),
    correlationId: 'test',
  };
}

const systemCtx = (capabilities: string[]): TenantContext => ({
  organizationId: ORG,
  principal: { kind: 'SYSTEM', actorName: 'publish-worker', capabilities },
  correlationId: 'test',
});

// ── The matrix, asserted cell by cell ────────────────────────────────────────

describe('grant matrix', () => {
  it('grants every role only what docs/RBAC.md records', () => {
    for (const role of ORGANIZATION_ROLES) {
      const granted = new Set(Object.keys(ROLE_GRANTS[role]));
      for (const permission of PERMISSIONS) {
        const c = ctx({
          organizationRole: role,
          // Give the principal every scope, so this test isolates the *grant*
          // rather than the scoping (which is covered separately below).
          workspaces: [{ workspaceId: WS_A, role: 'MANAGER' }],
          brands: [{ brandId: BRAND_A, canApprove: true }],
        });

        const allowed = can(c, permission, {
          workspaceId: WS_A,
          brandId: BRAND_A,
          createdById: USER,
        });

        expect(allowed, `${role} × ${permission}`).toBe(granted.has(permission));
      }
    }
  });

  it('denies every permission absent from a role, by default', () => {
    // A permission nobody has been granted must be denied for all seven roles.
    const ungranted = PERMISSIONS.filter(
      (p) => !ORGANIZATION_ROLES.some((r) => p in ROLE_GRANTS[r]),
    );
    expect(ungranted).toContain('social_credential:read_plaintext');

    for (const permission of ungranted) {
      for (const role of ORGANIZATION_ROLES) {
        expect(can(ctx({ organizationRole: role }), permission)).toBe(false);
      }
    }
  });

  it('grants no role a permission outside the catalogue', () => {
    for (const role of ORGANIZATION_ROLES) {
      for (const permission of Object.keys(ROLE_GRANTS[role])) {
        expect(PERMISSIONS, `${role} grants unknown permission ${permission}`).toContain(
          permission,
        );
      }
    }
  });
});

// ── The rules that matter most ──────────────────────────────────────────────

describe('credentials are unreachable', () => {
  it.each([...ORGANIZATION_ROLES])('denies %s plaintext credential access', (role) => {
    expect(can(ctx({ organizationRole: role }), 'social_credential:read_plaintext')).toBe(false);
  });

  it('denies it to platform admins too', () => {
    const decision = decide(
      ctx({ organizationRole: 'OWNER', isPlatformAdmin: true }),
      'social_credential:read_plaintext',
    );
    expect(decision).toEqual({ allowed: false, reason: 'UNGRANTABLE' });
  });

  it('denies it even to a system principal that asks for it explicitly', () => {
    expect(
      can(
        systemCtx(UNGRANTABLE_PERMISSIONS as unknown as string[]),
        'social_credential:read_plaintext',
      ),
    ).toBe(false);
  });
});

describe('separation of duties', () => {
  it('lets Approvers approve but never publish', () => {
    const approver = ctx({
      organizationRole: 'APPROVER',
      brands: [{ brandId: BRAND_A, canApprove: true }],
    });
    const resource = { workspaceId: WS_A, brandId: BRAND_A };

    expect(can(approver, 'post:approve_internal', resource)).toBe(true);
    expect(can(approver, 'post:publish_now', resource)).toBe(false);
    expect(can(approver, 'post:schedule', resource)).toBe(false);
  });

  it('lets Content Creators submit but never approve or publish', () => {
    const creator = ctx({ organizationRole: 'CONTENT_CREATOR' });
    const resource = { workspaceId: WS_A, brandId: BRAND_A, createdById: USER };

    expect(can(creator, 'post:submit_internal_review', resource)).toBe(true);
    expect(can(creator, 'post:approve_internal', resource)).toBe(false);
    expect(can(creator, 'post:approve_client', resource)).toBe(false);
    expect(can(creator, 'post:publish_now', resource)).toBe(false);
  });

  it('reserves billing changes to the Owner', () => {
    expect(can(ctx({ organizationRole: 'OWNER' }), 'billing:manage')).toBe(true);
    expect(can(ctx({ organizationRole: 'ADMIN' }), 'billing:manage')).toBe(false);
    expect(can(ctx({ organizationRole: 'ADMIN' }), 'billing:read')).toBe(true);
  });

  it('reserves deletion and hand-over to the Owner', () => {
    for (const permission of ['org:delete', 'org:transfer_ownership'] as const) {
      expect(can(ctx({ organizationRole: 'OWNER' }), permission)).toBe(true);
      expect(can(ctx({ organizationRole: 'ADMIN' }), permission)).toBe(false);
    }
  });
});

describe('client confinement', () => {
  const client = () =>
    ctx({
      organizationRole: 'CLIENT',
      workspaces: [{ workspaceId: WS_A, role: 'CLIENT_APPROVER' }],
      brands: [{ brandId: BRAND_A, canApprove: true }],
    });

  it('never lets a client read internal comments', () => {
    expect(can(client(), 'comment:read_internal', { workspaceId: WS_A, brandId: BRAND_A })).toBe(
      false,
    );
  });

  it('hides content that has not yet reached client review', () => {
    for (const status of ['IDEA', 'DRAFT', 'INTERNAL_REVIEW'] as const) {
      expect(can(client(), 'post:read', { workspaceId: WS_A, status })).toBe(false);
    }
    for (const status of ['CLIENT_REVIEW', 'APPROVED', 'PUBLISHED'] as const) {
      expect(can(client(), 'post:read', { workspaceId: WS_A, status })).toBe(true);
    }
  });

  it('only lets a client decide while the post is in client review', () => {
    expect(
      can(client(), 'post:approve_client', { workspaceId: WS_A, status: 'CLIENT_REVIEW' }),
    ).toBe(true);
    expect(can(client(), 'post:approve_client', { workspaceId: WS_A, status: 'APPROVED' })).toBe(
      false,
    );
  });

  it('cannot reach a workspace it does not belong to', () => {
    const decision = decide(client(), 'post:read', { workspaceId: WS_B, status: 'PUBLISHED' });
    expect(decision).toEqual({ allowed: false, reason: 'OUTSIDE_WORKSPACE' });
  });

  it('has no publishing, billing, audit or admin rights whatsoever', () => {
    for (const permission of [
      'post:publish_now',
      'post:schedule',
      'billing:read',
      'audit:read',
      'admin:view_jobs',
      'member:invite',
      'workspace:update',
    ] as const) {
      expect(can(client(), permission, { workspaceId: WS_A, brandId: BRAND_A })).toBe(false);
    }
  });
});

describe('scoping', () => {
  it('confines an Account Manager to their own workspaces', () => {
    const am = ctx({ organizationRole: 'ACCOUNT_MANAGER' });
    expect(can(am, 'post:publish_now', { workspaceId: WS_A })).toBe(true);
    expect(decide(am, 'post:publish_now', { workspaceId: WS_B })).toEqual({
      allowed: false,
      reason: 'OUTSIDE_WORKSPACE',
    });
  });

  it('gives Owners and Admins org-wide reach without a workspace membership', () => {
    for (const role of ['OWNER', 'ADMIN'] as const) {
      const c = ctx({ organizationRole: role, workspaces: [] });
      expect(can(c, 'post:publish_now', { workspaceId: WS_B })).toBe(true);
    }
  });

  it('fails closed when the scope needed to decide is missing', () => {
    const am = ctx({ organizationRole: 'ACCOUNT_MANAGER' });
    expect(decide(am, 'post:publish_now', {})).toEqual({
      allowed: false,
      reason: 'MISSING_SCOPE_INFORMATION',
    });
  });

  it('lets a brand assignment narrow, never widen', () => {
    // Assigned to BRAND_A but a member of WS_A only: a brand in WS_B stays out
    // of reach even though the principal holds an assignment somewhere.
    const creator = ctx({
      organizationRole: 'CONTENT_CREATOR',
      brands: [{ brandId: BRAND_A, canApprove: false }],
    });

    expect(can(creator, 'post:read', { workspaceId: WS_A, brandId: BRAND_A })).toBe(true);
    expect(can(creator, 'post:read', { workspaceId: WS_B, brandId: 'other-brand' })).toBe(false);
  });

  it('honours canApprove on a brand assignment', () => {
    const withRight = ctx({
      organizationRole: 'APPROVER',
      brands: [{ brandId: BRAND_A, canApprove: true }],
    });
    const withoutRight = ctx({
      organizationRole: 'APPROVER',
      brands: [{ brandId: BRAND_A, canApprove: false }],
    });
    const resource = { workspaceId: WS_A, brandId: BRAND_A };

    expect(can(withRight, 'post:approve_internal', resource)).toBe(true);
    expect(decide(withoutRight, 'post:approve_internal', resource)).toEqual({
      allowed: false,
      reason: 'NO_APPROVAL_RIGHT',
    });
  });

  it('restricts OWN-scoped grants to the creator', () => {
    const creator = ctx({ organizationRole: 'CONTENT_CREATOR' });
    expect(
      can(creator, 'post:update', { workspaceId: WS_A, createdById: USER, status: 'DRAFT' }),
    ).toBe(true);
    expect(
      decide(creator, 'post:update', {
        workspaceId: WS_A,
        createdById: OTHER_USER,
        status: 'DRAFT',
      }),
    ).toEqual({ allowed: false, reason: 'NOT_OWNER' });
  });
});

describe('edit locking', () => {
  it('stops anyone editing content from APPROVED onward', () => {
    for (const role of ['OWNER', 'ADMIN', 'ACCOUNT_MANAGER'] as const) {
      const c = ctx({ organizationRole: role });
      const base = { workspaceId: WS_A, brandId: BRAND_A, createdById: USER };

      expect(can(c, 'post:update', { ...base, status: 'DRAFT' })).toBe(true);
      expect(decide(c, 'post:update', { ...base, status: 'APPROVED' })).toEqual({
        allowed: false,
        reason: 'EDIT_LOCKED',
      });
      expect(can(c, 'post:update', { ...base, status: 'PUBLISHED' })).toBe(false);
    }
  });

  it('does not apply the lock to a transition out of a locked status', () => {
    // Reopening approved content is how the lock is meant to be escaped. If the
    // lock applied here too, APPROVED → DRAFT would be unreachable for every
    // role and the transition table's `voidsApprovals` rule would be dead.
    const c = ctx({ organizationRole: 'OWNER' });
    const base = { workspaceId: WS_A, brandId: BRAND_A, createdById: USER };

    expect(can(c, 'post:update', { ...base, status: 'APPROVED', intent: 'TRANSITION' })).toBe(true);
    expect(can(c, 'post:update', { ...base, status: 'SCHEDULED', intent: 'TRANSITION' })).toBe(
      true,
    );
  });

  it('still locks content edits when the intent is stated explicitly', () => {
    const c = ctx({ organizationRole: 'OWNER' });
    const base = { workspaceId: WS_A, brandId: BRAND_A, createdById: USER };

    expect(decide(c, 'post:update', { ...base, status: 'APPROVED', intent: 'EDIT' })).toEqual({
      allowed: false,
      reason: 'EDIT_LOCKED',
    });
  });

  it('does not let the transition intent bypass a status-restricted grant', () => {
    // The exemption covers the edit lock only. A Client's grants are limited to
    // the statuses that have reached them, and that restriction still binds.
    const client = ctx({
      organizationRole: 'CLIENT',
      workspaces: [{ workspaceId: WS_A, role: 'CLIENT_APPROVER' }],
      brands: [{ brandId: BRAND_A, canApprove: true }],
    });

    expect(
      can(client, 'post:approve_client', {
        workspaceId: WS_A,
        brandId: BRAND_A,
        status: 'DRAFT',
        intent: 'TRANSITION',
      }),
    ).toBe(false);
  });
});

describe('membership status', () => {
  it.each(['INVITED', 'SUSPENDED'] as const)('grants nothing to a %s member', (status) => {
    const c = ctx({ organizationRole: 'OWNER', membershipStatus: status });
    expect(decide(c, 'org:read')).toEqual({ allowed: false, reason: 'MEMBERSHIP_INACTIVE' });
    expect(effectivePermissions(c)).toEqual([]);
  });
});

describe('platform administrators', () => {
  it('can operate the platform', () => {
    const admin = ctx({ organizationRole: 'CONTENT_CREATOR', isPlatformAdmin: true });
    expect(can(admin, 'admin:view_jobs')).toBe(true);
    expect(can(admin, 'admin:retry_job')).toBe(true);
  });

  it('are not tenant superusers — no content access comes with the flag', () => {
    const admin = ctx({
      organizationRole: 'CLIENT',
      isPlatformAdmin: true,
      workspaces: [],
      brands: [],
    });
    expect(can(admin, 'post:read', { workspaceId: WS_A, status: 'PUBLISHED' })).toBe(false);
    expect(can(admin, 'brand_voice:read', { workspaceId: WS_A, brandId: BRAND_A })).toBe(false);
  });

  it('denies platform permissions to non-admins regardless of role', () => {
    const owner = ctx({ organizationRole: 'OWNER' });
    expect(decide(owner, 'admin:view_jobs')).toEqual({
      allowed: false,
      reason: 'NOT_PLATFORM_ADMIN',
    });
  });

  it('does not grant impersonation, which is not built', () => {
    const admin = ctx({ isPlatformAdmin: true });
    expect(can(admin, 'admin:impersonate')).toBe(false);
  });
});

describe('system principals', () => {
  it('hold only the capabilities they were constructed with — never root', () => {
    const worker = systemCtx(['post:retry_failed']);
    expect(can(worker, 'post:retry_failed')).toBe(true);
    expect(can(worker, 'post:publish_now')).toBe(false);
    expect(can(worker, 'org:delete')).toBe(false);
  });

  it('are not subject to workspace scoping, having no memberships', () => {
    const worker = systemCtx(['post:read']);
    expect(can(worker, 'post:read', { workspaceId: WS_B })).toBe(true);
  });
});

describe('assertCan', () => {
  it('throws a ForbiddenError carrying the denial reason for the log', () => {
    const creator = ctx({ organizationRole: 'CONTENT_CREATOR' });

    let thrown: ForbiddenError | undefined;
    try {
      assertCan(creator, 'post:publish_now', { workspaceId: WS_A });
    } catch (e) {
      thrown = e as ForbiddenError;
    }

    expect(thrown).toBeInstanceOf(ForbiddenError);
    expect(thrown!.status).toBe(403);
    expect(thrown!.context.reason).toBe('NO_GRANT');
    expect(thrown!.context.permission).toBe('post:publish_now');
    // The user-facing message never names the permission or the reason.
    expect(thrown!.userMessage).not.toContain('post:publish_now');
  });

  it('does not throw when permitted', () => {
    expect(() =>
      assertCan(ctx({ organizationRole: 'OWNER' }), 'post:publish_now', { workspaceId: WS_A }),
    ).not.toThrow();
  });
});

describe('effectivePermissions', () => {
  it('lists what a role holds, for the frontend to hide controls with', () => {
    const permissions = effectivePermissions(ctx({ organizationRole: 'APPROVER' }));
    expect(permissions).toContain('post:approve_internal');
    expect(permissions).not.toContain('post:publish_now');
  });

  it('adds platform grants for a platform admin', () => {
    const permissions = effectivePermissions(
      ctx({ organizationRole: 'ACCOUNT_MANAGER', isPlatformAdmin: true }),
    );
    expect(permissions).toContain('admin:view_jobs');
  });

  it('never includes an ungrantable permission', () => {
    for (const role of ORGANIZATION_ROLES) {
      const permissions = effectivePermissions(
        ctx({ organizationRole: role as OrganizationRole, isPlatformAdmin: true }),
      );
      for (const ungrantable of UNGRANTABLE_PERMISSIONS) {
        expect(permissions as Permission[]).not.toContain(ungrantable);
      }
    }
  });
});
