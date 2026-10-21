import { describe, expect, it } from 'vitest';
import { InvalidStateTransitionError } from './errors.js';
import { POST_STATUSES } from './enums.js';
import {
  APPROVAL_DECISIONS,
  assertAnswersCurrentGate,
  clientApprovalRequired,
  stageForStatus,
  statusAfterDecision,
} from './approvals.js';
import { canTransition } from './post-status.js';

describe('stageForStatus', () => {
  it('maps the two review statuses to their gates', () => {
    expect(stageForStatus('INTERNAL_REVIEW')).toBe('INTERNAL');
    expect(stageForStatus('CLIENT_REVIEW')).toBe('CLIENT');
  });

  it('reports no gate for every other status', () => {
    for (const status of POST_STATUSES) {
      if (status === 'INTERNAL_REVIEW' || status === 'CLIENT_REVIEW') continue;
      expect(stageForStatus(status)).toBeNull();
    }
  });
});

describe('statusAfterDecision', () => {
  it('sends an internal approval to the client when the client gate applies', () => {
    expect(statusAfterDecision('INTERNAL', 'APPROVED', true)).toBe('CLIENT_REVIEW');
  });

  it('finishes review on an internal approval when no client gate applies', () => {
    expect(statusAfterDecision('INTERNAL', 'APPROVED', false)).toBe('APPROVED');
  });

  it('finishes review on a client approval either way', () => {
    expect(statusAfterDecision('CLIENT', 'APPROVED', true)).toBe('APPROVED');
    expect(statusAfterDecision('CLIENT', 'APPROVED', false)).toBe('APPROVED');
  });

  it('sends any request for changes back to CHANGES_REQUESTED', () => {
    for (const stage of ['INTERNAL', 'CLIENT'] as const) {
      for (const required of [true, false]) {
        expect(statusAfterDecision(stage, 'CHANGES_REQUESTED', required)).toBe('CHANGES_REQUESTED');
      }
    }
  });

  it('only ever names a status the state machine can actually reach', () => {
    // The whole design rests on decisions being fed through the existing
    // machine. A target it cannot reach from the gate would be a dead end.
    for (const decision of APPROVAL_DECISIONS) {
      for (const required of [true, false]) {
        expect(
          canTransition('INTERNAL_REVIEW', statusAfterDecision('INTERNAL', decision, required)),
        ).toBe(true);
        expect(
          canTransition('CLIENT_REVIEW', statusAfterDecision('CLIENT', decision, required)),
        ).toBe(true);
      }
    }
  });
});

describe('assertAnswersCurrentGate', () => {
  it('accepts a pending record matching the post gate', () => {
    expect(() => {
      assertAnswersCurrentGate('INTERNAL_REVIEW', 'INTERNAL', 'PENDING');
    }).not.toThrow();
    expect(() => {
      assertAnswersCurrentGate('CLIENT_REVIEW', 'CLIENT', 'PENDING');
    }).not.toThrow();
  });

  it('refuses a record for the other stage', () => {
    // A stale internal approval must not be usable to answer a client gate.
    expect(() => {
      assertAnswersCurrentGate('CLIENT_REVIEW', 'INTERNAL', 'PENDING');
    }).toThrow(InvalidStateTransitionError);
  });

  it('refuses when the post is not at a gate at all', () => {
    for (const status of ['DRAFT', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'CANCELED'] as const) {
      expect(() => {
        assertAnswersCurrentGate(status, 'INTERNAL', 'PENDING');
      }).toThrow(InvalidStateTransitionError);
    }
  });

  it('refuses a record that has already been answered', () => {
    for (const state of ['APPROVED', 'CHANGES_REQUESTED', 'CANCELED'] as const) {
      expect(() => {
        assertAnswersCurrentGate('INTERNAL_REVIEW', 'INTERNAL', state);
      }).toThrow(InvalidStateTransitionError);
    }
  });
});

/**
 * Client approval applies only when the workspace has a client *and* the post
 * has not been exempted. An internal workspace must never wait on a client —
 * reading the post's flag alone was how an internal post would stall at
 * CLIENT_REVIEW for a client who does not exist.
 */
describe('clientApprovalRequired', () => {
  it.each([
    [true, true, true],
    // A client workspace, this post on standing approval (D-018).
    [true, false, false],
    // An agency's own workspace: no client, whatever the post says (D-106).
    [false, true, false],
    [false, false, false],
  ])('workspace %s · post %s → %s', (workspace, post, expected) => {
    expect(
      clientApprovalRequired({
        workspaceRequiresClientApproval: workspace,
        postApprovalRequired: post,
      }),
    ).toBe(expected);
  });
});
