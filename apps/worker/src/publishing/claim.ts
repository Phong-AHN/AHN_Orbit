import { CLAIM_TTL_MS, clock, newClaimToken } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';

/**
 * Idempotency **layer 2** — the atomic claim (docs/ARCHITECTURE.md §5.2).
 *
 * This is the real guarantee. Layers 1 and 3 reduce how often two workers reach
 * the same publish; this one makes it impossible for both to proceed when they
 * do. Everything else is optimisation or recovery.
 *
 * The whole mechanism is a single conditional UPDATE:
 *
 *   UPDATE "PostVariant" SET status='PUBLISHING', "claimedAt"=now(), "claimToken"=$1
 *   WHERE id=$2 AND status='SCHEDULED'
 *
 * Postgres serialises the row write, so exactly one concurrent caller sees a
 * row count of 1. Everyone else sees 0 and exits **without calling the
 * provider**. There is no read-then-write window for a race to live in, which
 * is why this is expressed as one statement rather than a find followed by an
 * update.
 *
 * It doubles as the cancellation check: a variant that was rescheduled,
 * unscheduled or cancelled is no longer `SCHEDULED`, so a job still sitting in
 * the queue for it claims nothing and does nothing. That is what lets T1.12
 * treat queue cancellation as best-effort.
 */

export interface Claim {
  variantId: string;
  token: string;
  claimedAt: Date;
}

export type ClaimResult =
  | { status: 'CLAIMED'; claim: Claim }
  /** Someone else owns it, or it is no longer scheduled. Exit quietly. */
  | { status: 'NOT_AVAILABLE'; reason: 'NOT_SCHEDULED' }
  /**
   * A previous worker died holding this. Its outcome is unknown, so the engine
   * must reconcile before it may publish — never retry blindly.
   */
  | { status: 'ABANDONED'; claim: Claim; previousClaimedAt: Date };

/**
 * Take the variant, or discover we cannot.
 *
 * `now` is injected so the abandoned-claim boundary is testable without waiting
 * fifteen minutes.
 */
export async function claimVariant(
  variantId: string,
  now: Date = clock.now(),
): Promise<ClaimResult> {
  const token = newClaimToken();

  // The ordinary path: an unclaimed, still-scheduled variant.
  const claimed = await platformDb.$executeRaw`
    UPDATE "PostVariant"
    SET status = 'PUBLISHING'::"VariantStatus",
        "claimedAt" = ${now},
        "claimToken" = ${token},
        "updatedAt" = ${now}
    WHERE id = ${variantId}::uuid
      AND status = 'SCHEDULED'::"VariantStatus"
      AND "deletedAt" IS NULL
  `;

  if (claimed === 1) {
    return { status: 'CLAIMED', claim: { variantId, token, claimedAt: now } };
  }

  // Nothing claimed. Either someone else holds it, or it is not publishable —
  // and the difference matters, because a stale claim needs reconciling.
  const current = await platformDb.postVariant.findUnique({
    where: { id: variantId },
    select: { status: true, claimedAt: true },
  });

  if (!current || current.status !== 'PUBLISHING' || !current.claimedAt) {
    return { status: 'NOT_AVAILABLE', reason: 'NOT_SCHEDULED' };
  }

  const heldFor = now.getTime() - current.claimedAt.getTime();
  if (heldFor <= CLAIM_TTL_MS) {
    // A live worker is on it. Ours is the duplicate.
    return { status: 'NOT_AVAILABLE', reason: 'NOT_SCHEDULED' };
  }

  // The claim is stale: the worker holding it died. Take it over — but the
  // caller must reconcile before publishing, because that worker may have
  // reached the provider before it died.
  const previousClaimedAt = current.claimedAt;

  const stolen = await platformDb.$executeRaw`
    UPDATE "PostVariant"
    SET "claimedAt" = ${now},
        "claimToken" = ${token},
        "updatedAt" = ${now}
    WHERE id = ${variantId}::uuid
      AND status = 'PUBLISHING'::"VariantStatus"
      AND "claimedAt" = ${previousClaimedAt}
  `;

  if (stolen !== 1) {
    // Another worker took it over between our read and our write.
    return { status: 'NOT_AVAILABLE', reason: 'NOT_SCHEDULED' };
  }

  logger.warn('took over an abandoned publish claim', {
    variantId,
    previousClaimedAt: previousClaimedAt.toISOString(),
    heldForMs: heldFor,
    note: 'reconciliation required before any publish',
  });

  return {
    status: 'ABANDONED',
    claim: { variantId, token, claimedAt: now },
    previousClaimedAt,
  };
}

/**
 * Give the variant back so a later attempt can take it.
 *
 * Used when the engine decides *not* to publish after claiming — a lock it
 * could not take, a rate limit, a retryable failure. The token is compared, so
 * a worker whose claim was already stolen cannot release someone else's.
 */
export async function releaseClaim(claim: Claim, to: 'SCHEDULED' = 'SCHEDULED'): Promise<boolean> {
  const released = await platformDb.$executeRaw`
    UPDATE "PostVariant"
    SET status = ${to}::"VariantStatus",
        "claimedAt" = NULL,
        "claimToken" = NULL,
        "updatedAt" = ${clock.now()}
    WHERE id = ${claim.variantId}::uuid
      AND "claimToken" = ${claim.token}
  `;

  return released === 1;
}

/**
 * Settle the variant on a terminal outcome, clearing the claim.
 *
 * Token-guarded for the same reason as release: a worker that lost its claim
 * to a takeover must not be able to write an outcome over the new owner's.
 */
export async function settleClaim(
  claim: Claim,
  outcome: {
    status: 'PUBLISHED' | 'FAILED' | 'NEEDS_REVIEW';
    externalPostId?: string | undefined;
    externalPermalink?: string | undefined;
    publishedAt?: Date | undefined;
    lastError?: { code: string; message: string } | undefined;
  },
): Promise<boolean> {
  const result = await platformDb.postVariant.updateMany({
    where: { id: claim.variantId, claimToken: claim.token },
    data: {
      status: outcome.status,
      claimedAt: null,
      claimToken: null,
      ...(outcome.externalPostId ? { externalPostId: outcome.externalPostId } : {}),
      ...(outcome.externalPermalink ? { externalPermalink: outcome.externalPermalink } : {}),
      ...(outcome.publishedAt ? { publishedAt: outcome.publishedAt } : {}),
      // Only the safe code and message — never a provider payload (SRS §33).
      ...(outcome.lastError ? { lastError: outcome.lastError } : {}),
    },
  });

  return result.count === 1;
}
