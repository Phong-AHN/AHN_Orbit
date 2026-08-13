import { describe, expect, it } from 'vitest';
import { POST_STATUSES, type PostStatus } from './enums.js';
import {
  TRANSITIONS,
  assertTransition,
  canTransition,
  humanTransitionsFrom,
  isEditLocked,
  isSystemWritten,
  isTerminal,
  transitionsFrom,
} from './post-status.js';
import { InvalidStateTransitionError } from './errors.js';

describe('post status machine', () => {
  it('permits exactly the transitions in the table and nothing else', () => {
    const legal = new Set(TRANSITIONS.map((t) => `${t.from}→${t.to}`));
    let illegalChecked = 0;

    for (const from of POST_STATUSES) {
      for (const to of POST_STATUSES) {
        const key = `${from}→${to}`;
        if (legal.has(key)) {
          expect(canTransition(from, to), `${key} should be legal`).toBe(true);
        } else {
          expect(canTransition(from, to), `${key} should be illegal`).toBe(false);
          illegalChecked++;
        }
      }
    }

    // 12 statuses => 144 pairs; sanity-check that we really swept the matrix.
    expect(illegalChecked + legal.size).toBe(POST_STATUSES.length ** 2);
  });

  it('rejects an illegal transition with the legal targets attached', () => {
    const err = (() => {
      try {
        assertTransition('DRAFT', 'PUBLISHED');
        return undefined;
      } catch (e) {
        return e as InvalidStateTransitionError;
      }
    })();

    expect(err).toBeInstanceOf(InvalidStateTransitionError);
    expect(err!.status).toBe(409);
    expect(err!.context.legalTargets).toEqual(
      expect.arrayContaining(['INTERNAL_REVIEW', 'CANCELED']),
    );
  });

  it('never lets a human write a system-only status — not even with permission', () => {
    for (const to of ['PUBLISHING', 'PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED'] as const) {
      const from: PostStatus = to === 'PUBLISHING' ? 'SCHEDULED' : 'PUBLISHING';
      expect(() => assertTransition(from, to, 'HUMAN')).toThrow(InvalidStateTransitionError);
      expect(() => assertTransition(from, to, 'SYSTEM')).not.toThrow();
    }
  });

  it('exposes no human transition into a system-written status', () => {
    for (const status of POST_STATUSES) {
      for (const t of humanTransitionsFrom(status)) {
        expect(isSystemWritten(t.to), `${t.from}→${t.to} must not be human-writable`).toBe(false);
      }
    }
  });

  it('marks system-only transitions as requiring no permission', () => {
    for (const t of TRANSITIONS) {
      if (t.actor === 'SYSTEM') expect(t.permission).toBeNull();
      else expect(t.permission).toBeTruthy();
    }
  });

  it('voids approvals when reopening content that was already approved', () => {
    expect(assertTransition('APPROVED', 'DRAFT').voidsApprovals).toBe(true);
    expect(assertTransition('SCHEDULED', 'DRAFT').voidsApprovals).toBe(true);
    // Reopening after changes were requested has nothing to void.
    expect(assertTransition('CHANGES_REQUESTED', 'DRAFT').voidsApprovals).toBe(false);
  });

  it('treats PUBLISHED and CANCELED as terminal', () => {
    expect(transitionsFrom('PUBLISHED')).toHaveLength(0);
    expect(transitionsFrom('CANCELED')).toHaveLength(0);
    expect(isTerminal('PUBLISHED')).toBe(true);
    expect(isTerminal('CANCELED')).toBe(true);
  });

  it('allows retrying from FAILED and PARTIALLY_PUBLISHED', () => {
    expect(assertTransition('FAILED', 'SCHEDULED').permission).toBe('post:retry_failed');
    expect(assertTransition('PARTIALLY_PUBLISHED', 'SCHEDULED').permission).toBe(
      'post:retry_failed',
    );
  });

  it('locks editing from APPROVED onward', () => {
    expect(isEditLocked('DRAFT')).toBe(false);
    expect(isEditLocked('CLIENT_REVIEW')).toBe(false);
    expect(isEditLocked('APPROVED')).toBe(true);
    expect(isEditLocked('SCHEDULED')).toBe(true);
    expect(isEditLocked('PUBLISHED')).toBe(true);
  });

  it('lets every non-terminal status be canceled', () => {
    for (const status of POST_STATUSES) {
      if (isTerminal(status) || isSystemWritten(status)) continue;
      expect(canTransition(status, 'CANCELED'), `${status} should be cancelable`).toBe(true);
    }
  });

  it('routes the client approval path through the client permission', () => {
    expect(assertTransition('CLIENT_REVIEW', 'APPROVED').permission).toBe('post:approve_client');
    expect(assertTransition('INTERNAL_REVIEW', 'APPROVED').permission).toBe(
      'post:approve_internal',
    );
  });
});
