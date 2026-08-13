import { clock, type AttemptOutcome } from '@orbit/core';
import { platformDb } from '@orbit/db';

/**
 * The attempt ledger (SRS §14; docs/ARCHITECTURE.md §5.2 layer 4).
 *
 * A `PublishingAttempt` row is written with state `IN_FLIGHT` **before** the
 * provider is called, and that ordering is the whole point: if the worker dies
 * mid-call, the row is the only evidence that a call may have reached the
 * platform. Writing it afterwards would lose exactly the case reconciliation
 * exists to handle.
 *
 * The ledger is also the audit trail a human reads when a publish goes wrong
 * (T1.14), so everything stored here has to be safe to render: a stable error
 * code, a vetted message, and whitelisted provider metadata. A raw Graph error
 * body can carry a token fragment and never goes in.
 */

export interface OpenAttempt {
  id: string;
  attemptNumber: number;
  startedAt: Date;
}

/**
 * Record that we are about to call the provider.
 *
 * The attempt number is derived from what already exists rather than passed in,
 * so a retry that lost track of its count cannot overwrite an earlier attempt —
 * the unique constraint on `(publishingJobId, attemptNumber)` would reject it.
 */
export async function openAttempt(input: {
  organizationId: string;
  publishingJobId: string;
  correlationId: string;
}): Promise<OpenAttempt> {
  const previous = await platformDb.publishingAttempt.findFirst({
    where: { publishingJobId: input.publishingJobId },
    orderBy: { attemptNumber: 'desc' },
    select: { attemptNumber: true },
  });

  const attemptNumber = (previous?.attemptNumber ?? 0) + 1;
  const startedAt = clock.now();

  const attempt = await platformDb.publishingAttempt.create({
    data: {
      organizationId: input.organizationId,
      publishingJobId: input.publishingJobId,
      attemptNumber,
      state: 'IN_FLIGHT',
      correlationId: input.correlationId,
      startedAt,
    },
    select: { id: true },
  });

  return { id: attempt.id, attemptNumber, startedAt };
}

/** Close an attempt with what actually happened. */
export async function closeAttempt(
  attempt: OpenAttempt,
  outcome: AttemptOutcome,
  extra: {
    /** Whitelisted, non-sensitive provider fields only (SRS §14, §33). */
    providerMeta?: Record<string, string | number | boolean> | undefined;
    httpStatus?: number | undefined;
    /** Safe message. Never a provider payload. */
    message?: string | undefined;
    retryable?: boolean | undefined;
    /** True when the outcome came from reconciliation rather than the call. */
    reconciled?: boolean | undefined;
  } = {},
): Promise<void> {
  const finishedAt = clock.now();

  await platformDb.publishingAttempt.update({
    where: { id: attempt.id },
    data: {
      state: attemptStateFor(outcome, extra.reconciled ?? false),
      finishedAt,
      durationMs: finishedAt.getTime() - attempt.startedAt.getTime(),
      ...(outcome.kind === 'PUBLISHED' ? { externalPostId: outcome.externalPostId } : {}),
      ...(outcome.kind !== 'PUBLISHED'
        ? {
            errorCode: 'code' in outcome ? outcome.code : 'INCONCLUSIVE',
            errorMessage: extra.message ?? null,
            errorRetryable: extra.retryable ?? false,
          }
        : {}),
      ...(extra.providerMeta ? { providerMeta: extra.providerMeta } : {}),
      ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    },
  });
}

function attemptStateFor(
  outcome: AttemptOutcome,
  reconciled: boolean,
): 'SUCCEEDED' | 'FAILED' | 'RECONCILED' | 'INCONCLUSIVE' {
  if (outcome.kind === 'PUBLISHED') {
    // A publish discovered by reconciliation is recorded as such: it succeeded,
    // but we learned it after the fact, and that distinction matters when
    // reading the trail.
    return reconciled ? 'RECONCILED' : 'SUCCEEDED';
  }

  if (outcome.kind === 'INCONCLUSIVE' || outcome.kind === 'AMBIGUOUS') return 'INCONCLUSIVE';

  return 'FAILED';
}

/**
 * An attempt left `IN_FLIGHT` — the signature of a worker that died mid-call.
 *
 * Its existence is what tells the next attempt it must reconcile rather than
 * publish. Returns the most recent, since that is the one whose outcome is
 * unknown.
 */
export async function findInFlightAttempt(publishingJobId: string): Promise<{
  id: string;
  attemptNumber: number;
  startedAt: Date;
  correlationId: string;
} | null> {
  return platformDb.publishingAttempt.findFirst({
    where: { publishingJobId, state: 'IN_FLIGHT' },
    orderBy: { attemptNumber: 'desc' },
    select: { id: true, attemptNumber: true, startedAt: true, correlationId: true },
  });
}

/** Move the job row alongside the attempt, so the two never disagree. */
export async function updateJobState(
  publishingJobId: string,
  state: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTER' | 'PENDING',
  extra: { lastErrorCode?: string | undefined; nextAttemptAt?: Date | null | undefined } = {},
): Promise<void> {
  await platformDb.publishingJob.update({
    where: { id: publishingJobId },
    data: {
      state,
      ...(state === 'RUNNING' ? { attemptCount: { increment: 1 } } : {}),
      ...(extra.lastErrorCode !== undefined ? { lastErrorCode: extra.lastErrorCode } : {}),
      ...(extra.nextAttemptAt !== undefined ? { nextAttemptAt: extra.nextAttemptAt } : {}),
    },
  });
}
