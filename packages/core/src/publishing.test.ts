import { describe, expect, it } from 'vitest';
import {
  CLAIM_TTL_MS,
  isClaimAbandoned,
  newClaimToken,
  postStatusFor,
  retryableVariantStatuses,
  summariseVariants,
  variantStatusFor,
  type AttemptOutcome,
} from './publishing.js';
import { assertTransition } from './post-status.js';
import type { VariantStatus } from './enums.js';

const NOW = new Date('2026-06-15T12:00:00Z');

describe('claim tokens', () => {
  it('is unique per call', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => newClaimToken()));
    expect(tokens.size).toBe(100);
  });

  it('treats a fresh claim as live', () => {
    const claimedAt = new Date(NOW.getTime() - 1_000);
    expect(isClaimAbandoned(claimedAt, NOW)).toBe(false);
  });

  it('treats a claim past its TTL as abandoned', () => {
    const claimedAt = new Date(NOW.getTime() - CLAIM_TTL_MS - 1_000);
    expect(isClaimAbandoned(claimedAt, NOW)).toBe(true);
  });

  it('does not call a claim abandoned exactly at the boundary', () => {
    // Off-by-one here would let two workers reconcile the same publish.
    const claimedAt = new Date(NOW.getTime() - CLAIM_TTL_MS);
    expect(isClaimAbandoned(claimedAt, NOW)).toBe(false);
  });
});

describe('variantStatusFor', () => {
  it('settles a published attempt', () => {
    expect(
      variantStatusFor({
        kind: 'PUBLISHED',
        externalPostId: 'x',
        publishedAt: NOW,
      }),
    ).toBe('PUBLISHED');
  });

  it('returns a retryable attempt to SCHEDULED so it can be reclaimed', () => {
    expect(variantStatusFor({ kind: 'RETRYABLE', code: 'PROVIDER_UNAVAILABLE' })).toBe('SCHEDULED');
  });

  it('settles a final failure', () => {
    expect(variantStatusFor({ kind: 'FAILED', code: 'PROVIDER_VALIDATION_ERROR' })).toBe('FAILED');
  });

  it('parks anything whose outcome is unknown', () => {
    // The rule the whole design rests on: never guess about an ambiguous
    // publish. Both of these wait for a human.
    expect(variantStatusFor({ kind: 'AMBIGUOUS', code: 'PUBLISHING_TIMEOUT' })).toBe(
      'NEEDS_REVIEW',
    );
    expect(variantStatusFor({ kind: 'INCONCLUSIVE', reason: 'could not check' })).toBe(
      'NEEDS_REVIEW',
    );
  });

  it('never maps any outcome to PUBLISHING', () => {
    // PUBLISHING means "a worker holds this right now"; no *outcome* implies it.
    const outcomes: AttemptOutcome[] = [
      { kind: 'PUBLISHED', externalPostId: 'x', publishedAt: NOW },
      { kind: 'RETRYABLE', code: 'a' },
      { kind: 'FAILED', code: 'b' },
      { kind: 'AMBIGUOUS', code: 'c' },
      { kind: 'INCONCLUSIVE', reason: 'd' },
    ];

    for (const outcome of outcomes) {
      expect(variantStatusFor(outcome)).not.toBe('PUBLISHING');
    }
  });
});

describe('summariseVariants', () => {
  it('counts each outcome', () => {
    const summary = summariseVariants([
      'PUBLISHED',
      'PUBLISHED',
      'FAILED',
      'NEEDS_REVIEW',
      'SCHEDULED',
    ]);

    expect(summary).toEqual({
      published: 2,
      failed: 1,
      needsReview: 1,
      pending: 1,
      total: 5,
    });
  });

  it('excludes a cancelled account from the total', () => {
    // A cancelled account is not a failure and not an outcome — a post whose
    // other accounts published is PUBLISHED, not PARTIALLY_PUBLISHED.
    const summary = summariseVariants(['PUBLISHED', 'CANCELED']);

    expect(summary.total).toBe(1);
    expect(summary.published).toBe(1);
  });

  it('counts PUBLISHING as pending', () => {
    expect(summariseVariants(['PUBLISHING']).pending).toBe(1);
  });
});

describe('postStatusFor (partial publishing)', () => {
  function statusOf(statuses: VariantStatus[]) {
    return postStatusFor(summariseVariants(statuses));
  }

  it('waits while any variant is still in flight', () => {
    // The bug this prevents: a post flipping to FAILED because the first of
    // three accounts errored while the others were still going.
    expect(statusOf(['FAILED', 'PUBLISHING'])).toBeNull();
    expect(statusOf(['PUBLISHED', 'SCHEDULED'])).toBeNull();
    expect(statusOf(['FAILED', 'PUBLISHED', 'PUBLISHING'])).toBeNull();
  });

  it('publishes when every account succeeded', () => {
    expect(statusOf(['PUBLISHED', 'PUBLISHED', 'PUBLISHED'])).toBe('PUBLISHED');
  });

  it('fails when every account failed', () => {
    expect(statusOf(['FAILED', 'FAILED'])).toBe('FAILED');
  });

  it('is partly published when some worked and some did not', () => {
    expect(statusOf(['PUBLISHED', 'FAILED'])).toBe('PARTIALLY_PUBLISHED');
  });

  it('is partly published when some worked and others are unresolved', () => {
    // NEEDS_REVIEW is not a failure — the outcome is unknown — so the honest
    // description is "partly published".
    expect(statusOf(['PUBLISHED', 'NEEDS_REVIEW'])).toBe('PARTIALLY_PUBLISHED');
  });

  it('is partly published when nothing published but something is unresolved', () => {
    // Calling this FAILED would be a claim we cannot support: the parked
    // variant may well have gone out.
    expect(statusOf(['FAILED', 'NEEDS_REVIEW'])).toBe('PARTIALLY_PUBLISHED');
    expect(statusOf(['NEEDS_REVIEW'])).toBe('PARTIALLY_PUBLISHED');
  });

  it('cancels a post whose every account was cancelled', () => {
    expect(statusOf(['CANCELED', 'CANCELED'])).toBe('CANCELED');
  });

  it('only ever names a status the machine can reach from PUBLISHING', () => {
    // The rollup writes through `assertTransition(..., 'SYSTEM')`, so a target
    // it cannot reach would be a dead end at runtime.
    const reachable: VariantStatus[][] = [
      ['PUBLISHED'],
      ['FAILED'],
      ['PUBLISHED', 'FAILED'],
      ['NEEDS_REVIEW'],
    ];

    for (const statuses of reachable) {
      const target = statusOf(statuses);
      expect(target).not.toBeNull();
      expect(() => assertTransition('PUBLISHING', target as never, 'SYSTEM')).not.toThrow();
    }
  });

  it('refuses those same transitions for a human actor', () => {
    // docs/RBAC.md §5: no role reaches a system-written status, however their
    // permissions are configured.
    for (const target of ['PUBLISHED', 'PARTIALLY_PUBLISHED', 'FAILED'] as const) {
      expect(() => assertTransition('PUBLISHING', target, 'HUMAN')).toThrow();
    }
  });
});

describe('retryableVariantStatuses', () => {
  it('is exactly FAILED', () => {
    // A published variant must never be re-attempted, and a parked one is
    // waiting on a human — retrying it would be the guess the design forbids.
    expect(retryableVariantStatuses()).toEqual(['FAILED']);
    expect(retryableVariantStatuses()).not.toContain('PUBLISHED');
    expect(retryableVariantStatuses()).not.toContain('NEEDS_REVIEW');
  });
});
