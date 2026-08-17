import { randomUUID } from 'node:crypto';
import type { PostStatus, VariantStatus } from './enums.js';

/**
 * Publishing lifecycle rules (SRS §13, §14; docs/ARCHITECTURE.md §5.2).
 *
 * Pure domain logic — no database, no queue, no provider. It answers three
 * questions the engine needs and nothing else:
 *
 *   1. what a claim token is, and how long a claim may be held;
 *   2. what an attempt's outcome means for the variant;
 *   3. what a set of settled variants means for the post.
 *
 * Question 3 is the partial-publishing rule, and it is the one worth stating
 * plainly: a post that reached *some* of its accounts is neither published nor
 * failed. `PARTIALLY_PUBLISHED` exists so that distinction survives, because
 * the recovery action differs — retrying a partial publish must touch only the
 * accounts that failed.
 */

/**
 * How long a worker may hold a claim before another may take it.
 *
 * Longer than any plausible provider call plus the reconciliation that follows
 * one, and shorter than a human's patience. A claim older than this belongs to
 * a worker that died; the reconciler decides what happened, never a blind retry.
 */
export const CLAIM_TTL_MS = 15 * 60 * 1_000;

/**
 * Window either side of an attempt to search when reconciling.
 *
 * Wide enough to cover a slow provider that accepted the post minutes after we
 * gave up on the response, narrow enough that an unrelated post with identical
 * content — the same caption reused next week — cannot be mistaken for ours.
 */
export const RECONCILE_WINDOW_MS = 10 * 60 * 1_000;

/** A fresh claim token. Opaque; only ever compared, never parsed. */
export function newClaimToken(): string {
  return randomUUID();
}

/** Whether a claim has been held long enough to be considered abandoned. */
export function isClaimAbandoned(claimedAt: Date, now: Date, ttlMs = CLAIM_TTL_MS): boolean {
  return now.getTime() - claimedAt.getTime() > ttlMs;
}

// ── Attempt outcomes ────────────────────────────────────────────────────────

/**
 * What happened on one attempt, in terms the engine acts on.
 *
 * `AMBIGUOUS` is deliberately distinct from `FAILED`: it means the provider
 * never told us, so the post may or may not exist. Collapsing the two is
 * exactly how a duplicate publish happens.
 */
export type AttemptOutcome =
  | { kind: 'PUBLISHED'; externalPostId: string; permalink?: string | undefined; publishedAt: Date }
  /** Confirmed not published, and worth trying again. */
  | { kind: 'RETRYABLE'; code: string }
  /**
   * Confirmed not published, and retrying cannot help.
   *
   * `clientStanding` marks the failures that are about **our application**
   * rather than this connection — a platform refusing what an unaudited or
   * capped API client may do. They arrive as permission errors and must not
   * demote the account: reconnecting resolves nothing, and taking a working
   * connection out of service sends somebody through an OAuth round trip for a
   * problem that lives in a developer portal.
   */
  | { kind: 'FAILED'; code: string; clientStanding?: boolean | undefined }
  /** The provider never answered. Reconciliation decides, never a retry. */
  | { kind: 'AMBIGUOUS'; code: string }
  /** Reconciliation ran and could not tell. A human decides. */
  | { kind: 'INCONCLUSIVE'; reason: string };

/** The variant status an outcome leads to. */
export function variantStatusFor(outcome: AttemptOutcome): VariantStatus {
  switch (outcome.kind) {
    case 'PUBLISHED':
      return 'PUBLISHED';
    case 'RETRYABLE':
      // Stays claimable: the retry re-enters through the queue and re-claims.
      return 'SCHEDULED';
    case 'FAILED':
      return 'FAILED';
    case 'AMBIGUOUS':
    case 'INCONCLUSIVE':
      // Parked. Nothing automated touches it again — SRS §13 forbids guessing.
      return 'NEEDS_REVIEW';
    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unhandled attempt outcome: ${String(exhaustive)}`);
    }
  }
}

// ── Rolling variants up to the post ─────────────────────────────────────────

export interface VariantOutcomeSummary {
  published: number;
  failed: number;
  needsReview: number;
  /** Still to be attempted, or mid-attempt. */
  pending: number;
  total: number;
}

export function summariseVariants(statuses: readonly VariantStatus[]): VariantOutcomeSummary {
  const summary: VariantOutcomeSummary = {
    published: 0,
    failed: 0,
    needsReview: 0,
    pending: 0,
    total: statuses.length,
  };

  for (const status of statuses) {
    switch (status) {
      case 'PUBLISHED':
        summary.published += 1;
        break;
      case 'FAILED':
        summary.failed += 1;
        break;
      case 'NEEDS_REVIEW':
        summary.needsReview += 1;
        break;
      case 'CANCELED':
        // A cancelled account is not a failure and not an outcome; it simply
        // stops counting, so a post whose other accounts published is
        // PUBLISHED rather than PARTIALLY_PUBLISHED.
        summary.total -= 1;
        break;
      default:
        summary.pending += 1;
        break;
    }
  }

  return summary;
}

/**
 * The post status a set of variant outcomes implies, or `null` while any
 * variant is still in flight.
 *
 * Returning `null` rather than a guess is what stops a post flipping to FAILED
 * because the first of three accounts errored while the others were still
 * going. The post settles once, when everything has.
 *
 * A variant parked as `NEEDS_REVIEW` counts as *not published* for this
 * purpose but does not make the post FAILED on its own — the outcome is
 * unknown, and `PARTIALLY_PUBLISHED` is the honest description of a post where
 * some accounts worked and others are unresolved.
 */
export function postStatusFor(summary: VariantOutcomeSummary): PostStatus | null {
  if (summary.pending > 0) return null;
  if (summary.total === 0) return 'CANCELED';

  if (summary.published === summary.total) return 'PUBLISHED';
  if (summary.published === 0 && summary.needsReview === 0) return 'FAILED';

  return 'PARTIALLY_PUBLISHED';
}

/**
 * Variants a retry should touch.
 *
 * Only the ones that failed outright. A published variant must never be
 * re-attempted, and a parked one is waiting on a human — retrying it would be
 * the guess the design forbids.
 */
export function retryableVariantStatuses(): readonly VariantStatus[] {
  return ['FAILED'];
}
