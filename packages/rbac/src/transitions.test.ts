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
import {
  allowedTransitions,
  assertTransitionAllowed,
  authorMayFinish,
  canTransition,
} from './transitions.js';

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

/**
 * An author may finish their own post in a workspace with no client (D-106).
 *
 * Every test below except the first two is a refusal, on purpose. The rule
 * widens what a Content Creator may do, so the cases that matter most are the
 * ones where one of its four conditions is missing and it must not apply.
 */
describe('an author finishing their own post in an internal workspace', () => {
  const creator = ctx({ organizationRole: 'CONTENT_CREATOR' });
  const internal = { ...resource, requiresClientApproval: false };
  const OTHER = '018f0000-0000-7000-8000-0000000000u2';

  it('lets the author approve their own post', () => {
    expect(canTransition(creator, 'INTERNAL_REVIEW', 'APPROVED', internal)).toBe(true);
  });

  /** Approval alone would leave the post waiting on someone who can schedule. */
  it('lets the author schedule what they approved', () => {
    expect(canTransition(creator, 'APPROVED', 'SCHEDULED', internal)).toBe(true);
  });

  it('offers the author the Approve button', () => {
    expect(allowedTransitions(creator, 'INTERNAL_REVIEW', internal)).toContain('APPROVED');
  });

  /** A client workspace keeps its separation of duties exactly as before. */
  it('does nothing in a workspace that has a client', () => {
    const client = { ...resource, requiresClientApproval: true };
    expect(canTransition(creator, 'INTERNAL_REVIEW', 'APPROVED', client)).toBe(false);
    expect(canTransition(creator, 'APPROVED', 'SCHEDULED', client)).toBe(false);
  });

  /** A caller that forgets the flag must get the ordinary grants, never wider. */
  it('does nothing when the flag is not passed at all', () => {
    expect(canTransition(creator, 'INTERNAL_REVIEW', 'APPROVED', resource)).toBe(false);
  });

  it('does nothing for somebody else’s post', () => {
    const theirs = { ...internal, createdById: OTHER };
    expect(canTransition(creator, 'INTERNAL_REVIEW', 'APPROVED', theirs)).toBe(false);
  });

  /** Someone who has left the workspace cannot keep approving their old posts. */
  it('does nothing for an author no longer in the workspace', () => {
    const departed = ctx({ organizationRole: 'CONTENT_CREATOR', workspaces: [] });
    expect(canTransition(departed, 'INTERNAL_REVIEW', 'APPROVED', internal)).toBe(false);
  });

  /**
   * Exactly two moves. Not sending to a client who does not exist, and not
   * anything that is not already in the table.
   */
  it('grants no move beyond approving and scheduling', () => {
    expect(canTransition(creator, 'INTERNAL_REVIEW', 'CLIENT_REVIEW', internal)).toBe(false);
    expect(canTransition(creator, 'CLIENT_REVIEW', 'APPROVED', internal)).toBe(false);
  });

  /** The machine still rules first: a move that does not exist stays a 409. */
  it('cannot unlock a transition the machine does not have', () => {
    expect(() => assertTransitionAllowed(creator, 'DRAFT', 'SCHEDULED', internal)).toThrow(
      InvalidStateTransitionError,
    );
  });

  it('refuses with the ordinary 403 when it does not apply', () => {
    expect(() =>
      assertTransitionAllowed(creator, 'INTERNAL_REVIEW', 'APPROVED', {
        ...internal,
        createdById: OTHER,
      }),
    ).toThrow(ForbiddenError);
  });
});

/**
 * The author check is load-bearing even though the OWN anchor overlaps it today.
 *
 * An Account Manager's submit grant is workspace-wide, so their anchor passes for
 * any post in the workspace. Without the author check, the rule would let them
 * "finish" a post they did not write. They hold `approve_internal` anyway, so the
 * public API cannot show the difference — which is exactly why this asks the
 * rule directly: it is the case a future grant change would expose.
 */
describe('authorMayFinish, asked directly', () => {
  const manager = ctx({ organizationRole: 'ACCOUNT_MANAGER' });
  const internal = { ...resource, requiresClientApproval: false };

  it('holds for the author', () => {
    expect(authorMayFinish(manager, 'INTERNAL_REVIEW', 'APPROVED', internal)).toBe(true);
  });

  it('refuses a broad submitter who did not write the post', () => {
    const theirs = { ...internal, createdById: '018f0000-0000-7000-8000-0000000000u9' };
    expect(authorMayFinish(manager, 'INTERNAL_REVIEW', 'APPROVED', theirs)).toBe(false);
  });
});
