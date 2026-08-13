import { describe, expect, it } from 'vitest';
import {
  ForbiddenError,
  InvalidStateTransitionError,
  POST_STATUSES,
  TRANSITIONS,
  type TenantContext,
  type UserPrincipal,
} from '@orbit/core';
import { isPermission } from './permissions.js';
import { allowedTransitions, assertTransitionAllowed, canTransition } from './transitions.js';

const WS = '018f0000-0000-7000-8000-0000000000w1';
const BRAND = '018f0000-0000-7000-8000-0000000000b1';
const USER = '018f0000-0000-7000-8000-0000000000u1';

function ctx(overrides: Partial<UserPrincipal> = {}): TenantContext {
  return {
    organizationId: '018f0000-0000-7000-8000-0000000000aa',
    principal: {
      kind: 'USER',
      userId: USER,
      email: 'u@ahn.test',
      isPlatformAdmin: false,
      organizationRole: 'ACCOUNT_MANAGER',
      membershipStatus: 'ACTIVE',
      workspaces: [{ workspaceId: WS, role: 'MANAGER' }],
      brands: [],
      ...overrides,
    },
    correlationId: 'test',
  };
}

const resource = { workspaceId: WS, brandId: BRAND, createdById: USER };

describe('state machine and policy stay in step', () => {
  it('names a real permission on every human transition', () => {
    for (const rule of TRANSITIONS) {
      if (rule.actor !== 'HUMAN') continue;
      expect(isPermission(rule.permission ?? ''), `${rule.from}→${rule.to}`).toBe(true);
    }
  });
});

describe('assertTransitionAllowed', () => {
  it('rejects an illegal transition before it ever checks permissions', () => {
    // An Owner holds every content permission; the transition is still refused,
    // which proves the machine is consulted first.
    expect(() =>
      assertTransitionAllowed(ctx({ organizationRole: 'OWNER' }), 'DRAFT', 'PUBLISHED', resource),
    ).toThrow(InvalidStateTransitionError);
  });

  it('refuses a system-only transition to every human role', () => {
    for (const role of ['OWNER', 'ADMIN', 'ACCOUNT_MANAGER'] as const) {
      expect(() =>
        assertTransitionAllowed(
          ctx({ organizationRole: role }),
          'SCHEDULED',
          'PUBLISHING',
          resource,
        ),
      ).toThrow(InvalidStateTransitionError);
    }
  });

  it('throws ForbiddenError — not a 409 — when the transition is legal but unpermitted', () => {
    expect(() =>
      assertTransitionAllowed(
        ctx({ organizationRole: 'CONTENT_CREATOR' }),
        'APPROVED',
        'SCHEDULED',
        resource,
      ),
    ).toThrow(ForbiddenError);
  });

  it('permits the happy path for an Account Manager', () => {
    const am = ctx();
    expect(() => assertTransitionAllowed(am, 'APPROVED', 'SCHEDULED', resource)).not.toThrow();
    expect(() => assertTransitionAllowed(am, 'DRAFT', 'INTERNAL_REVIEW', resource)).not.toThrow();
  });
});

describe('client approval path', () => {
  const client = ctx({
    organizationRole: 'CLIENT',
    workspaces: [{ workspaceId: WS, role: 'CLIENT_APPROVER' }],
  });

  it('lets a client approve out of client review', () => {
    expect(canTransition(client, 'CLIENT_REVIEW', 'APPROVED', { workspaceId: WS })).toBe(true);
  });

  it('lets a client request changes', () => {
    expect(canTransition(client, 'CLIENT_REVIEW', 'CHANGES_REQUESTED', { workspaceId: WS })).toBe(
      true,
    );
  });

  it('does not let a client approve internally, schedule, or cancel', () => {
    expect(canTransition(client, 'INTERNAL_REVIEW', 'APPROVED', { workspaceId: WS })).toBe(false);
    expect(canTransition(client, 'APPROVED', 'SCHEDULED', { workspaceId: WS })).toBe(false);
    expect(canTransition(client, 'SCHEDULED', 'CANCELED', { workspaceId: WS })).toBe(false);
  });
});

describe('allowedTransitions', () => {
  it('never offers a system-written status to any role', () => {
    for (const role of [
      'OWNER',
      'ADMIN',
      'ACCOUNT_MANAGER',
      'CONTENT_CREATOR',
      'APPROVER',
    ] as const) {
      for (const status of POST_STATUSES) {
        const targets = allowedTransitions(ctx({ organizationRole: role }), status, resource);
        expect(targets).not.toContain('PUBLISHING');
        expect(targets).not.toContain('PUBLISHED');
        expect(targets).not.toContain('PARTIALLY_PUBLISHED');
        expect(targets).not.toContain('FAILED');
      }
    }
  });

  it('offers a Content Creator only submission out of their own draft', () => {
    const creator = ctx({ organizationRole: 'CONTENT_CREATOR' });
    expect(allowedTransitions(creator, 'DRAFT', resource)).toEqual(['INTERNAL_REVIEW']);
  });

  it('offers an Approver both decisions out of internal review', () => {
    const approver = ctx({
      organizationRole: 'APPROVER',
      brands: [{ brandId: BRAND, canApprove: true }],
    });
    const targets = allowedTransitions(approver, 'INTERNAL_REVIEW', resource);
    expect(targets).toEqual(expect.arrayContaining(['CHANGES_REQUESTED', 'CLIENT_REVIEW']));
    expect(targets).not.toContain('CANCELED');
  });

  it('offers nothing at all from a terminal status', () => {
    const owner = ctx({ organizationRole: 'OWNER' });
    expect(allowedTransitions(owner, 'PUBLISHED', resource)).toEqual([]);
    expect(allowedTransitions(owner, 'CANCELED', resource)).toEqual([]);
  });
});
