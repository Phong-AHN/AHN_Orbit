import { describe, expect, it } from 'vitest';
import {
  AGENT_SCOPES,
  ForbiddenError,
  ORGANIZATION_ROLES,
  type AgentDelegation,
  type OrganizationRole,
  type TenantContext,
  type UserPrincipal,
} from '@orbit/core';
import { PERMISSIONS, PLATFORM_PERMISSIONS, type Permission } from './permissions.js';
import { can, canSomewhere, decide, effectivePermissions } from './policy.js';
import { assertTransitionAllowed, canTransition } from './transitions.js';
import {
  AGENT_CONFIRMATION_REQUIRED,
  AGENT_SCOPE_PERMISSIONS,
  agentScopeCovers,
  assertAgentConfirmed,
} from './agent.js';

const ORG = '018f0000-0000-7000-8000-0000000000aa';
const WS_A = '018f0000-0000-7000-8000-0000000000w1';
const WS_B = '018f0000-0000-7000-8000-0000000000w2';
const USER = '018f0000-0000-7000-8000-0000000000u1';

const ALL_SCOPES: AgentDelegation = { channel: 'MCP', grantId: 'g1', scopes: [...AGENT_SCOPES] };
const CONFIRMED: AgentDelegation = { ...ALL_SCOPES, confirmedActionId: 'a1' };

function ctx(
  role: OrganizationRole,
  delegation: AgentDelegation | undefined,
  overrides: Partial<UserPrincipal> = {},
): TenantContext {
  const principal: UserPrincipal = {
    kind: 'USER',
    userId: USER,
    email: 'user@ahn.test',
    isPlatformAdmin: false,
    organizationRole: role,
    membershipStatus: 'ACTIVE',
    workspaces: [{ workspaceId: WS_A, role: 'MANAGER' }],
    brands: [],
    ...(delegation ? { delegation } : {}),
    ...overrides,
  };
  return { organizationId: ORG, principal, correlationId: 'test' };
}

const everywhere = { workspaceId: WS_A, createdById: USER };

/**
 * Permissions no agent may hold under any scope (docs/AGENT-MCP-PLAN.md §1.2).
 * Listed out rather than derived, so widening the scope map is a visible
 * change to this test as well.
 */
const NEVER_DELEGATED: Permission[] = [
  'org:update',
  'org:delete',
  'org:transfer_ownership',
  'member:invite',
  'member:list',
  'member:update_role',
  'member:remove',
  'audit:read',
  'workspace:create',
  'workspace:update',
  'workspace:delete',
  'workspace:manage_members',
  'brand:create',
  'brand:update',
  'brand:delete',
  'brand_voice:update',
  'social_account:connect',
  'social_account:reconnect',
  'social_account:disconnect',
  'social_credential:read_plaintext',
  'post:delete',
  'post:delete_published_remote',
  'post:assign',
  'task:delete',
  'message:reply_ai',
  'ai_assistant:manage',
  'media:delete',
  'billing:read',
  'billing:manage',
  ...PLATFORM_PERMISSIONS,
];

describe('agent delegation (D-109)', () => {
  it('maps only catalogue permissions, and never a never-delegated one', () => {
    for (const [scope, permissions] of Object.entries(AGENT_SCOPE_PERMISSIONS)) {
      for (const permission of permissions) {
        expect(PERMISSIONS, `${scope} → ${permission}`).toContain(permission);
        expect(NEVER_DELEGATED, `${scope} → ${permission}`).not.toContain(permission);
      }
    }
  });

  it('denies every never-delegated permission to an Owner holding every scope', () => {
    const owner = ctx('OWNER', CONFIRMED, { isPlatformAdmin: true });
    for (const permission of NEVER_DELEGATED) {
      expect(can(owner, permission, everywhere), permission).toBe(false);
      expect(canSomewhere(owner, permission), permission).toBe(false);
    }
    expect(effectivePermissions(owner).some((p) => NEVER_DELEGATED.includes(p))).toBe(false);
  });

  it('never grants an agent more than its user holds, for any role and permission', () => {
    for (const role of ORGANIZATION_ROLES) {
      for (const permission of PERMISSIONS) {
        if (can(ctx(role, CONFIRMED), permission, everywhere)) {
          expect(can(ctx(role, undefined), permission, everywhere), `${role} ${permission}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('confines an agent to the scopes it was given', () => {
    const readOnly = ctx('OWNER', { channel: 'MCP', grantId: 'g1', scopes: ['read'] });
    expect(can(readOnly, 'post:read', everywhere)).toBe(true);
    expect(decide(readOnly, 'post:create', everywhere)).toEqual({
      allowed: false,
      reason: 'OUTSIDE_AGENT_SCOPE',
    });
    expect(can(readOnly, 'message:read', everywhere)).toBe(false);
  });

  it('refuses every outward permission until the action is confirmed', () => {
    const unconfirmed = ctx('OWNER', ALL_SCOPES);
    for (const permission of AGENT_CONFIRMATION_REQUIRED) {
      expect(decide(unconfirmed, permission, everywhere), permission).toEqual({
        allowed: false,
        reason: 'AGENT_CONFIRMATION_REQUIRED',
      });
      // A confirmation only lifts the agent gate; the role decides the rest.
      expect(can(ctx('OWNER', CONFIRMED), permission, everywhere), permission).toBe(
        can(ctx('OWNER', undefined), permission, everywhere),
      );
    }
  });

  it('keeps the user boundaries: another workspace stays out of reach', () => {
    const manager = ctx('ACCOUNT_MANAGER', CONFIRMED);
    expect(can(manager, 'post:read', { workspaceId: WS_A })).toBe(true);
    expect(can(manager, 'post:read', { workspaceId: WS_B })).toBe(false);
  });

  it('gives a Content Creator agent no publishing, even confirmed', () => {
    const creator = ctx('CONTENT_CREATOR', CONFIRMED, {
      workspaces: [{ workspaceId: WS_A, role: 'CREATOR' }],
    });
    expect(can(creator, 'post:publish_now', everywhere)).toBe(false);
    expect(can(creator, 'post:schedule', everywhere)).toBe(false);
  });

  it('lists only what the scopes cover in effectivePermissions, never platform rights', () => {
    const delegation: AgentDelegation = { channel: 'COPILOT', scopes: ['read'] };
    const readOnly = ctx('OWNER', delegation, { isPlatformAdmin: true });
    const listed = effectivePermissions(readOnly);
    expect(listed.length).toBeGreaterThan(0);
    for (const permission of listed) expect(agentScopeCovers(delegation, permission)).toBe(true);
    expect(listed).not.toContain('admin:view_jobs');
  });
});

describe('agent transitions (D-109)', () => {
  const owner = (delegation: AgentDelegation = ALL_SCOPES) => ctx('OWNER', delegation);

  it('lets an agent move work towards review on its own', () => {
    expect(canTransition(owner(), 'DRAFT', 'INTERNAL_REVIEW', everywhere)).toBe(true);
    expect(canTransition(owner(), 'IDEA', 'DRAFT', everywhere)).toBe(true);
    expect(canTransition(owner(), 'CHANGES_REQUESTED', 'DRAFT', everywhere)).toBe(true);
  });

  it('needs a confirmation to take a post off the schedule, though that is post:update', () => {
    expect(canTransition(owner(), 'SCHEDULED', 'DRAFT', everywhere)).toBe(false);
    expect(canTransition(owner(), 'APPROVED', 'DRAFT', everywhere)).toBe(false);
    expect(canTransition(owner(CONFIRMED), 'SCHEDULED', 'DRAFT', everywhere)).toBe(true);
  });

  it('needs a confirmation to approve or schedule', () => {
    expect(() => assertTransitionAllowed(owner(), 'APPROVED', 'SCHEDULED', everywhere)).toThrow(
      ForbiddenError,
    );
    expect(canTransition(owner(), 'INTERNAL_REVIEW', 'APPROVED', everywhere)).toBe(false);
    expect(canTransition(owner(CONFIRMED), 'APPROVED', 'SCHEDULED', everywhere)).toBe(true);
  });

  it('does not let the D-106 author shortcut skip the agent gate', () => {
    const creator = (delegation?: AgentDelegation) =>
      ctx('CONTENT_CREATOR', delegation, { workspaces: [{ workspaceId: WS_A, role: 'CREATOR' }] });
    const internal = { ...everywhere, requiresClientApproval: false };

    // The author themselves may finish their own internal post…
    expect(canTransition(creator(), 'APPROVED', 'SCHEDULED', internal)).toBe(true);
    // …their agent may not without a confirmation…
    expect(canTransition(creator(ALL_SCOPES), 'APPROVED', 'SCHEDULED', internal)).toBe(false);
    // …nor without the workflow scope, even confirmed…
    const noWorkflow: AgentDelegation = {
      channel: 'MCP',
      scopes: ['read', 'content'],
      confirmedActionId: 'a1',
    };
    expect(canTransition(creator(noWorkflow), 'APPROVED', 'SCHEDULED', internal)).toBe(false);
    // …and with both, it is exactly what the author could do.
    expect(canTransition(creator(CONFIRMED), 'APPROVED', 'SCHEDULED', internal)).toBe(true);
  });
});

describe('assertAgentConfirmed (D-109)', () => {
  it('never affects a person', () => {
    expect(() => assertAgentConfirmed(ctx('OWNER', undefined), 'message:reply')).not.toThrow();
  });

  it('refuses an agent until the action was confirmed', () => {
    expect(() => assertAgentConfirmed(ctx('OWNER', ALL_SCOPES), 'message:reply')).toThrow(
      ForbiddenError,
    );
    expect(() => assertAgentConfirmed(ctx('OWNER', CONFIRMED), 'message:reply')).not.toThrow();
  });
});
