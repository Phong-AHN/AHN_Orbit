import {
  CLAIM_TTL_MS,
  HEALTH_CONFIRM_DELAY_MS,
  PublishingTimeoutError,
  RECONCILE_WINDOW_MS,
  THREAD_CONTINUES,
  accountStatusForErrorCode,
  clock,
  isClientStandingFailure,
  isAppError,
  isStale,
  type AttemptOutcome,
  type ErrorCode,
  type Platform,
  type TenantContext,
} from '@orbit/core';
import { PUBLISH_WORKER_CAPABILITIES, systemContext } from '@orbit/auth';
import { platformDb } from '@orbit/db';
import type { Prisma } from '@orbit/db';
import { logger, logError, recordProviderError, recordPublishOutcome } from '@orbit/observability';
import {
  LOCK_UNAVAILABLE,
  enqueue,
  publishLockKey,
  rateLimitKey,
  resolveJobTenant,
  takeToken,
  withLock,
  type JobContext,
} from '@orbit/queue';
import {
  capabilitiesFor,
  getProvider,
  isThreadContinuation,
  tryGetProvider,
} from '@orbit/providers';
import { workerBuild } from '../build-info.js';
import { claimVariant, releaseClaim, settleClaim, type Claim } from './claim.js';
import { closeAttempt, findInFlightAttempt, openAttempt, updateJobState } from './attempts.js';
import { markPostPublishing, rollUpPost } from './rollup.js';
import { loadPublishSubject, type PublishSubject } from './subject.js';

/**
 * The publishing engine (SRS §13, §14; docs/ARCHITECTURE.md §5.2).
 *
 * Exactly-once publishing against a provider that offers no idempotency key.
 * Four layers, in the order they engage:
 *
 *   **1. Deterministic job id** — the scheduler enqueues with the idempotency
 *      key as the BullMQ job id, so a duplicate add is dropped (T1.12).
 *   **2. Atomic claim in Postgres** — one conditional UPDATE. Exactly one
 *      concurrent worker wins; the rest exit without calling the provider.
 *      *This is the real guarantee.*
 *   **3. Redis lock per account** — bounds concurrent calls to one platform
 *      account and cooperates with the rate limiter. Advisory: a lost lock
 *      cannot cause a duplicate, because layer 2 already prevented one.
 *   **4. Reconciliation before retry** — an attempt row is written `IN_FLIGHT`
 *      *before* the call. If the outcome is ever unknown, the next attempt asks
 *      the provider what happened instead of publishing again.
 *
 * The rule that ties them together: **an ambiguous outcome is never retried.**
 * A timeout means the post may exist. The engine reconciles; if that is
 * inconclusive the variant parks in `NEEDS_REVIEW` for a human, and nothing
 * automated touches it again.
 */

/** How long a provider call may run before we give up and reconcile. */
const PUBLISH_TIMEOUT_MS = 60_000;

/** How long the account lock is held. Comfortably longer than the call. */
const LOCK_TTL_MS = 90_000;

/**
 * Publishing budget per account.
 *
 * Deliberately conservative and *not* platform-specific: the real ceiling comes
 * from the capability descriptor's `publishing.rateLimit`, and the adapter
 * narrows the bucket adaptively from its own response headers (T1.11).
 */
const DEFAULT_RATE_LIMIT = { capacity: 10, refillWindowMs: 60_000 };

/**
 * Deferred because another run holds the claim (see `claimVariant`'s `HELD`).
 * The processor reschedules it without spending an attempt.
 */
export const CLAIM_HELD = 'CLAIM_HELD';

/** How long after a held claim ages out the variant is looked at again. */
const CLAIM_RECHECK_MARGIN_MS = 30_000;

/** A platform this worker has no adapter for — its credentials are not set. */
export const PROVIDER_NOT_CONFIGURED = 'PROVIDER_NOT_CONFIGURED';

const PLATFORM_LABEL: Record<Platform, string> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  THREADS: 'Threads',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  LINKEDIN: 'LinkedIn',
  PINTEREST: 'Pinterest',
  X: 'X',
  BLUESKY: 'Bluesky',
};

export type PublishOutcomeKind =
  'PUBLISHED' | 'ALREADY_SETTLED' | 'NOT_CLAIMABLE' | 'DEFERRED' | 'FAILED' | 'PARKED';

export interface PublishRunResult {
  kind: PublishOutcomeKind;
  variantId: string;
  externalPostId?: string | undefined;
  /** Set when the engine wants the job retried rather than failed. */
  requeueAfterMs?: number | undefined;
  reason?: string | undefined;
}

/**
 * Publish one variant.
 *
 * Throws only when the queue layer should decide what happens next — a
 * retryable provider error, or a rate limit. Every terminal outcome is
 * returned, because the engine has already recorded it and a throw would only
 * make the queue re-run work that is done.
 */
export async function publishVariant(job: JobContext<'publish'>): Promise<PublishRunResult> {
  const { payload, correlationId } = job;

  // ── Tenant derivation (decision D-021) ────────────────────────────────────
  // The subject row is the authority on which tenant this belongs to. The
  // payload's `organizationId` is compared, never trusted, and a mismatch is a
  // tenant-isolation security event.
  const row = await platformDb.postVariant.findUnique({
    where: { id: payload.postVariantId },
    select: {
      organizationId: true,
      platform: true,
      postId: true,
      post: { select: { workspaceId: true, brandId: true } },
    },
  });

  const organizationId = resolveJobTenant(payload.organizationId, row, {
    queue: 'publish',
    jobId: job.jobId,
    subjectType: 'postVariant',
    subjectId: payload.postVariantId,
  });

  const ctx = systemContext({
    organizationId,
    actorName: 'publish-worker',
    capabilities: PUBLISH_WORKER_CAPABILITIES,
    correlationId,
  });

  // ── Layer 2: the atomic claim ─────────────────────────────────────────────
  const claimResult = await claimVariant(payload.postVariantId);

  if (claimResult.status === 'NOT_AVAILABLE') {
    // Someone else owns it, or it is no longer scheduled — rescheduled,
    // unscheduled, cancelled, or already published. Exiting quietly here is
    // what makes queue cancellation safe to treat as best-effort (T1.12).
    logger.info('publish skipped; variant is not claimable', {
      variantId: payload.postVariantId,
      organizationId,
    });
    return { kind: 'NOT_CLAIMABLE', variantId: payload.postVariantId };
  }

  if (claimResult.status === 'HELD') {
    // Most likely a live worker, and this the duplicate: when it finishes, the
    // look later finds nothing to claim. But a worker that stopped mid-publish
    // holds a claim too, and its job comes back long before the claim can be
    // taken over — so look again just after it can be, when an abandoned one is
    // reconciled rather than left PUBLISHING for good.
    const requeueAfterMs =
      Math.max(0, CLAIM_TTL_MS - claimResult.heldForMs) + CLAIM_RECHECK_MARGIN_MS;
    logger.info('publish claim held by another run; looking again once it can be taken over', {
      variantId: payload.postVariantId,
      organizationId,
      heldForMs: claimResult.heldForMs,
      requeueAfterMs,
    });
    return {
      kind: 'DEFERRED',
      variantId: payload.postVariantId,
      requeueAfterMs,
      reason: CLAIM_HELD,
    };
  }

  const claim = claimResult.claim;

  // A stolen claim means a worker died mid-publish. Its outcome is unknown, so
  // the first thing we do is find out — never publish.
  const mustReconcileFirst = claimResult.status === 'ABANDONED';

  const run: ClaimedRun = {
    ctx,
    organizationId,
    claim,
    publishingJobId: payload.publishingJobId,
    correlationId,
    mustReconcileFirst,
    ...(claimResult.status === 'ABANDONED'
      ? { abandonedSince: claimResult.previousClaimedAt }
      : {}),
  };

  try {
    // A platform this worker cannot publish to fails visibly, once. Before, the
    // missing adapter threw while loading the post, the claim was handed back
    // and the job dead-lettered — and the post said "Scheduled" for ever.
    if (row && !tryGetProvider(row.platform)) {
      return await failUnconfigured(run, {
        platform: row.platform,
        postId: row.postId,
        workspaceId: row.post.workspaceId,
        brandId: row.post.brandId,
      });
    }

    return await runClaimedPublish(run);
  } catch (error) {
    // Anything that escapes here has not been recorded as a terminal outcome,
    // so the variant goes back to SCHEDULED and the queue layer decides whether
    // to retry. Leaving it PUBLISHING would strand it until the claim expires.
    await releaseClaim(claim).catch(() => false);
    throw error;
  }
}

interface ClaimedRun {
  ctx: TenantContext;
  organizationId: string;
  claim: Claim;
  publishingJobId: string;
  correlationId: string;
  mustReconcileFirst: boolean;
  /** When the abandoned claim this run took over was first taken. */
  abandonedSince?: Date | undefined;
}

async function runClaimedPublish(run: ClaimedRun): Promise<PublishRunResult> {
  const startedAt = Date.now();
  const subject = await loadPublishSubject(run.ctx, run.claim.variantId);

  // The post travels through PUBLISHING too — `SCHEDULED → PUBLISHED` is not a
  // transition the machine has, for the post any more than for the variant.
  // Idempotent, so the second account of a multi-account post finds it done.
  await markPostPublishing(subject.postId);

  // ── Layer 4, first half: is there an unresolved earlier attempt? ──────────
  // Either this worker took over an abandoned claim, or a previous attempt was
  // left IN_FLIGHT. Both mean the outcome of a provider call is unknown.
  const orphaned = await findInFlightAttempt(run.publishingJobId);

  if (run.mustReconcileFirst || orphaned) {
    // When the lost publish began — not this run's claim, which is seconds
    // old: reconciliation looks for the post around the time it was sent.
    const attemptedAt = orphaned?.startedAt ?? run.abandonedSince ?? run.claim.claimedAt;
    const resolved = await reconcileUnknownOutcome({ run, subject, attemptedAt });

    if (resolved) return resolved;

    // NOT_FOUND: the earlier call never landed, so publishing now is safe —
    // but not necessarily wanted. A publish lost hours ago is the same "too
    // late to publish unattended" the scheduler refuses, so it waits for a
    // person instead of going out days after it should have.
    if (isStale(attemptedAt)) {
      return applyOutcome(run, subject, {
        kind: 'INCONCLUSIVE',
        reason:
          'This did not go out: publishing stopped part-way, and it is now too late to publish it unattended. Retry it if it is still wanted, or abandon it.',
      });
    }
  }

  // ── Layer 3: one publish at a time per account ────────────────────────────
  const lockKey = publishLockKey(subject.socialAccountId);

  const result = await withLock(lockKey, LOCK_TTL_MS, async () => {
    // Provider rate limit, checked inside the lock so the check and the call
    // cannot be separated by another worker's publish.
    const capabilities = capabilitiesFor(subject.platform, subject.accountType);
    const configured = capabilities.publishing.rateLimit;

    const budget = configured
      ? {
          capacity: Math.max(1, Math.min(configured.maxPosts, DEFAULT_RATE_LIMIT.capacity)),
          refillWindowMs: configured.windowMs,
        }
      : DEFAULT_RATE_LIMIT;

    const token = await takeToken(rateLimitKey(subject.platform, subject.socialAccountId), budget);

    if (!token.allowed) {
      // Not a failure. The queue reschedules without consuming an attempt.
      return { rateLimited: true, retryAfterMs: token.retryAfterMs } as const;
    }

    return { rateLimited: false, outcome: await attemptPublish(run, subject) } as const;
  });

  const settle = (outcome: PublishRunResult): PublishRunResult => {
    // Recorded here rather than at each return, so a new outcome cannot be
    // added without passing through the metric (T1.19).
    recordPublishOutcome({
      platform: subject.platform,
      outcome: outcome.kind,
      durationSeconds: (Date.now() - startedAt) / 1_000,
    });
    return outcome;
  };

  if (result === LOCK_UNAVAILABLE) {
    // Another worker holds this account. Give the variant back and come round
    // again shortly — holding a worker slot blocking would be worse.
    await releaseClaim(run.claim);
    return settle({
      kind: 'DEFERRED',
      variantId: run.claim.variantId,
      requeueAfterMs: 15_000,
      reason: 'ACCOUNT_BUSY',
    });
  }

  if (result.rateLimited) {
    await releaseClaim(run.claim);
    return settle({
      kind: 'DEFERRED',
      variantId: run.claim.variantId,
      requeueAfterMs: result.retryAfterMs,
      reason: 'RATE_LIMIT',
    });
  }

  return settle(await applyOutcome(run, subject, result.outcome));
}

/**
 * One provider call, bracketed by the attempt ledger.
 *
 * The `IN_FLIGHT` row is written first and deliberately: if this process dies
 * during the call, that row is the only evidence a publish may have happened.
 */
async function attemptPublish(run: ClaimedRun, subject: PublishSubject): Promise<AttemptOutcome> {
  await updateJobState(run.publishingJobId, 'RUNNING');

  const attempt = await openAttempt({
    organizationId: run.organizationId,
    publishingJobId: run.publishingJobId,
    correlationId: run.correlationId,
  });

  const provider = getProvider(subject.platform);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PUBLISH_TIMEOUT_MS);

  try {
    const published = await provider.publish({
      credential: subject.credential,
      account: {
        externalId: subject.externalId,
        ...(subject.accountType !== null ? { accountType: subject.accountType } : {}),
      },
      draft: subject.draft,
      media: subject.media,
      ...(subject.previousRef ? { previousRef: subject.previousRef } : {}),
      contentHash: subject.contentHash,
      correlationId: run.correlationId,
      signal: controller.signal,
      /**
       * A provider handle, written straight through to the row before the
       * adapter makes a call it may not get an answer to.
       *
       * Awaited, and deliberately not batched with the outcome write: the whole
       * value of this handle is that it is durable at the moment the process
       * could die, and anything deferred to the end would not be there in the
       * only case that matters. What is inside it is the adapter's business —
       * this stores an opaque object and never reads it (**D-055**).
       */
      recordProviderRef: async (ref) => {
        await platformDb.postVariant.update({
          where: { id: subject.variantId },
          data: { providerRef: ref as Prisma.InputJsonValue },
        });
      },
    });

    const outcome: AttemptOutcome = {
      kind: 'PUBLISHED',
      externalPostId: published.externalPostId,
      permalink: published.permalink,
      publishedAt: published.publishedAt,
    };

    await closeAttempt(attempt, outcome, {
      providerMeta: published.providerMeta,
    });

    return outcome;
  } catch (error) {
    return classifyAndMaybeReconcile(run, subject, attempt, error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a thrown error into an outcome, reconciling when the answer is unknown.
 *
 * The branch that matters: a `PublishingTimeoutError` is **not** a failure. The
 * post may exist. We ask the provider before deciding anything, and if it
 * cannot tell us, the variant is parked rather than retried.
 */
async function classifyAndMaybeReconcile(
  run: ClaimedRun,
  subject: PublishSubject,
  attempt: Awaited<ReturnType<typeof openAttempt>>,
  error: unknown,
): Promise<AttemptOutcome> {
  const ambiguous = error instanceof PublishingTimeoutError || isAbortError(error);

  if (isThreadContinuation(error)) return closeThreadPause(run, subject, attempt, error);

  if (!ambiguous) {
    const code = isAppError(error) ? error.code : 'INTERNAL_ERROR';
    const retryable = isAppError(error) ? error.retryable : true;
    const message = isAppError(error)
      ? error.userMessage
      : 'The platform could not be reached. We will try again.';

    const outcome: AttemptOutcome = retryable
      ? { kind: 'RETRYABLE', code }
      : { kind: 'FAILED', code, clientStanding: isClientStandingFailure(error) };

    await closeAttempt(attempt, outcome, {
      message,
      retryable,
      // The attempt row is what the publishing page reads, and it was keeping
      // only the user-facing sentence — so a failure could be *seen* in the
      // product but never diagnosed there. `AppError.context` is already the
      // whitelisted, non-sensitive set the logger emits (codes, http status,
      // Meta's fbtrace id); `scrubMeta` keeps it to flat scalars so nothing
      // structured can smuggle a payload into the column.
      ...(isAppError(error)
        ? { providerMeta: { ...scrubMeta(error.context), ...workerBuild() } }
        : {}),
      ...(isAppError(error) && typeof error.context?.['httpStatus'] === 'number'
        ? { httpStatus: error.context['httpStatus'] }
        : {}),
    });

    // Normalised code, never the provider's own message: low cardinality, and a
    // rise in one code is a different incident from a rise in another (T1.19).
    recordProviderError(subject.platform, code);

    logError('publish attempt failed', error, {
      variantId: subject.variantId,
      organizationId: run.organizationId,
      errorCode: code,
      retryable,
    });

    return outcome;
  }

  // ── Layer 4: reconcile before deciding anything ───────────────────────────
  logger.warn('publish outcome is unknown; reconciling before any retry', {
    variantId: subject.variantId,
    organizationId: run.organizationId,
    attemptNumber: attempt.attemptNumber,
  });

  const reconciled = await reconcile(run, subject, attempt.startedAt);

  await closeAttempt(attempt, reconciled, {
    message:
      reconciled.kind === 'PUBLISHED'
        ? 'Recovered by reconciliation: the post had already gone out.'
        : reconciled.kind === 'INCONCLUSIVE'
          ? 'We could not confirm whether this published. Waiting for a human.'
          : 'The platform did not respond, and the post had not gone out.',
    reconciled: true,
    retryable: reconciled.kind === 'RETRYABLE',
  });

  return reconciled;
}

/**
 * Fail a variant whose platform this worker has no adapter for.
 *
 * Nothing is sent: the adapter that would send it does not exist here, which
 * means the platform's credentials are not set on the worker (they are read
 * once, at start). Recorded as an ordinary failure — an attempt row, the
 * variant FAILED, the post rolled up, a notification — so the reason is on the
 * post. Retrying after the worker is configured publishes it.
 */
async function failUnconfigured(
  run: ClaimedRun,
  variant: { platform: Platform; postId: string; workspaceId: string; brandId: string },
): Promise<PublishRunResult> {
  const label = PLATFORM_LABEL[variant.platform] ?? variant.platform;

  logger.error('platform is not set up on this worker; failed the publish without calling it', {
    platform: variant.platform,
    variantId: run.claim.variantId,
    organizationId: run.organizationId,
  });

  return failWithoutPublishing(run, variant, {
    code: PROVIDER_NOT_CONFIGURED,
    message: `${label} isn't set up on the publishing service yet, so nothing was sent. Once an administrator has finished setting it up there, retry this post.`,
    recordAttempt: true,
  });
}

/**
 * Settle a claimed variant as FAILED without calling the platform.
 *
 * The same record a failed publish leaves — variant, job, audit, post roll-up,
 * notification — so the post shows why, and offers a retry. `recordAttempt`
 * adds an attempt row carrying the message, for a failure that happened before
 * any attempt could say so.
 */
async function failWithoutPublishing(
  run: ClaimedRun,
  variant: { postId: string; workspaceId: string; brandId: string },
  failure: { code: string; message: string; recordAttempt: boolean },
): Promise<PublishRunResult> {
  const subject = {
    variantId: run.claim.variantId,
    workspaceId: variant.workspaceId,
    brandId: variant.brandId,
  };

  // The post moves through PUBLISHING to be rolled up, as for any publish.
  await markPostPublishing(variant.postId);

  if (failure.recordAttempt) {
    const attempt = await openAttempt({
      organizationId: run.organizationId,
      publishingJobId: run.publishingJobId,
      correlationId: run.correlationId,
    });
    await closeAttempt(
      attempt,
      { kind: 'FAILED', code: failure.code },
      { message: failure.message, retryable: false },
    );
  }

  await settleClaim(run.claim, {
    status: 'FAILED',
    lastError: { code: failure.code, message: failure.message },
  });
  await updateJobState(run.publishingJobId, 'FAILED', { lastErrorCode: failure.code });
  await auditPublish(run, subject, 'post_variant.publish_failed', { errorCode: failure.code });
  await rollUpPost(variant.postId);
  await raiseNotification(run, subject, 'publishing.failed');

  return { kind: 'FAILED', variantId: subject.variantId, reason: failure.code };
}

/**
 * Fail a variant the queue is giving up on, so it does not sit "Scheduled"
 * with no job left to run it.
 *
 * Before 2026-11-23, a publish whose retries ran out — or that hit an error no
 * retry can fix — had already been handed back as `SCHEDULED` by the engine,
 * and the queue dead-lettered its job. Nothing marked it failed, and the
 * scheduler would not queue it again (its job row already existed), so the
 * post said "Scheduled" for ever.
 *
 * Only a `SCHEDULED` variant of the same tenant is touched, and it is claimed
 * first like any publish: one in flight, published or parked is left exactly
 * as it is. Nothing is sent. Returns whether it failed the variant.
 */
export async function giveUpPublish(input: {
  postVariantId: string;
  publishingJobId: string;
  organizationId: string;
  correlationId: string;
  code: string;
  message: string;
}): Promise<boolean> {
  const row = await platformDb.postVariant.findUnique({
    where: { id: input.postVariantId },
    select: {
      organizationId: true,
      postId: true,
      post: { select: { workspaceId: true, brandId: true } },
    },
  });
  // A mismatch is the publish path's to report as a security event; here it
  // only means there is nothing of this tenant's to settle.
  if (!row || row.organizationId !== input.organizationId) return false;

  const claimResult = await claimVariant(input.postVariantId);
  if (claimResult.status !== 'CLAIMED') return false;

  const run: ClaimedRun = {
    ctx: systemContext({
      organizationId: row.organizationId,
      actorName: 'publish-worker',
      capabilities: PUBLISH_WORKER_CAPABILITIES,
      correlationId: input.correlationId,
    }),
    organizationId: row.organizationId,
    claim: claimResult.claim,
    publishingJobId: input.publishingJobId,
    correlationId: input.correlationId,
    mustReconcileFirst: false,
  };

  try {
    await failWithoutPublishing(
      run,
      { postId: row.postId, workspaceId: row.post.workspaceId, brandId: row.post.brandId },
      { code: input.code, message: input.message, recordAttempt: false },
    );
  } catch (error) {
    await releaseClaim(claimResult.claim).catch(() => false);
    throw error;
  }

  logger.warn('publishing gave up; the variant is failed rather than left scheduled', {
    variantId: input.postVariantId,
    organizationId: row.organizationId,
    errorCode: input.code,
  });
  return true;
}

/**
 * A thread that stopped between two parts after putting a post live (D-124).
 *
 * Progress, not failure: the adapter only marks a pause this way once the
 * attempt posted something, and recorded it, so the next run continues from
 * the next part. Closed with its own code so the trail reads "continuing";
 * kept out of the provider-error metric and the error log, where a thread
 * moving along would look like an outage.
 */
async function closeThreadPause(
  run: ClaimedRun,
  subject: PublishSubject,
  attempt: Awaited<ReturnType<typeof openAttempt>>,
  error: unknown,
): Promise<AttemptOutcome> {
  const outcome: AttemptOutcome = { kind: 'RETRYABLE', code: THREAD_CONTINUES };
  const context = isAppError(error) ? error.context : {};

  await closeAttempt(attempt, outcome, {
    message: isAppError(error) ? error.userMessage : undefined,
    retryable: true,
    providerMeta: { ...scrubMeta(context), ...workerBuild() },
  });

  logger.info('thread paused between posts; continuing', {
    variantId: subject.variantId,
    organizationId: run.organizationId,
    platform: subject.platform,
    threadPosted: context['threadPosted'],
    threadTotal: context['threadTotal'],
  });

  return outcome;
}

/**
 * Ask the provider whether a post we are unsure about actually exists.
 *
 * Matched on `contentHash` within a window bracketing the attempt — the same
 * fingerprint the scheduler stamped on the variant. A provider that cannot be
 * queried (`reconcilable: false`) yields INCONCLUSIVE immediately: guessing
 * would be the one thing this design forbids.
 */
async function reconcile(
  run: ClaimedRun,
  subject: PublishSubject,
  attemptedAt: Date,
): Promise<AttemptOutcome> {
  const capabilities = capabilitiesFor(subject.platform, subject.accountType);

  if (!capabilities.publishing.reconcilable) {
    return {
      kind: 'INCONCLUSIVE',
      reason: 'The platform cannot be asked whether the post exists.',
    };
  }

  try {
    const provider = getProvider(subject.platform);

    // Read fresh rather than from `subject`, which was loaded before the
    // attempt: the handle is written *during* publishing, so a copy taken
    // beforehand would never have it.
    const row = await platformDb.postVariant.findUnique({
      where: { id: subject.variantId },
      select: { providerRef: true },
    });

    const providerRef =
      row?.providerRef && typeof row.providerRef === 'object' && !Array.isArray(row.providerRef)
        ? (row.providerRef as Record<string, unknown>)
        : undefined;

    const result = await provider.reconcile({
      credential: subject.credential,
      account: {
        externalId: subject.externalId,
        ...(subject.accountType !== null ? { accountType: subject.accountType } : {}),
      },
      contentHash: subject.contentHash,
      body: subject.draft.body,
      ...(providerRef ? { providerRef } : {}),
      attemptedAt,
      windowMs: RECONCILE_WINDOW_MS,
      correlationId: run.correlationId,
    });

    if (result.outcome === 'FOUND') {
      logger.warn('reconciliation found the post had already published', {
        variantId: subject.variantId,
        organizationId: run.organizationId,
        externalPostId: result.externalPostId,
        note: 'a blind retry here would have double-posted',
      });

      return {
        kind: 'PUBLISHED',
        externalPostId: result.externalPostId,
        permalink: result.permalink,
        publishedAt: result.publishedAt,
      };
    }

    if (result.outcome === 'NOT_FOUND') {
      // Confirmed absent, so trying again is safe.
      return { kind: 'RETRYABLE', code: 'PUBLISHING_TIMEOUT' };
    }

    return { kind: 'INCONCLUSIVE', reason: result.reason };
  } catch (error) {
    // Reconciliation itself failed. We know less than before, so the only safe
    // answer is to park it — retrying could double-post.
    logError('reconciliation failed; parking the variant', error, {
      variantId: subject.variantId,
      organizationId: run.organizationId,
    });

    return {
      kind: 'INCONCLUSIVE',
      reason: 'We could not check whether the post went out.',
    };
  }
}

/**
 * Reconcile an outcome left unknown by a *previous* worker.
 *
 * Returns a result when the question is settled, or `null` when the earlier
 * call demonstrably never landed and publishing may proceed.
 */
async function reconcileUnknownOutcome(input: {
  run: ClaimedRun;
  subject: PublishSubject;
  attemptedAt: Date;
}): Promise<PublishRunResult | null> {
  const { run, subject } = input;

  const outcome = await reconcile(run, subject, input.attemptedAt);

  // Close the orphaned attempt so it stops being treated as unresolved.
  const orphan = await findInFlightAttempt(run.publishingJobId);
  if (orphan) {
    await closeAttempt(
      { id: orphan.id, attemptNumber: orphan.attemptNumber, startedAt: orphan.startedAt },
      outcome,
      {
        message: 'Resolved by reconciliation after the previous worker stopped responding.',
        reconciled: true,
        retryable: outcome.kind === 'RETRYABLE',
      },
    );
  }

  if (outcome.kind === 'RETRYABLE') return null;

  return applyOutcome(run, subject, outcome);
}

/**
 * Write the outcome to the variant, the job and the post.
 *
 * Everything terminal ends here, so there is exactly one place that decides
 * what an outcome means for stored state.
 */
async function applyOutcome(
  run: ClaimedRun,
  subject: PublishSubject,
  outcome: AttemptOutcome,
): Promise<PublishRunResult> {
  switch (outcome.kind) {
    case 'PUBLISHED': {
      await settleClaim(run.claim, {
        status: 'PUBLISHED',
        externalPostId: outcome.externalPostId,
        externalPermalink: outcome.permalink,
        publishedAt: outcome.publishedAt,
      });
      await updateJobState(run.publishingJobId, 'SUCCEEDED');
      await auditPublish(run, subject, 'post_variant.published', {
        externalPostId: outcome.externalPostId,
      });
      await rollUpPost(subject.postId);

      logger.info('published', {
        variantId: subject.variantId,
        organizationId: run.organizationId,
        externalPostId: outcome.externalPostId,
      });

      return {
        kind: 'PUBLISHED',
        variantId: subject.variantId,
        externalPostId: outcome.externalPostId,
      };
    }

    case 'FAILED': {
      await settleClaim(run.claim, {
        status: 'FAILED',
        lastError: { code: outcome.code, message: safeMessageFor(outcome.code) },
      });
      await updateJobState(run.publishingJobId, 'FAILED', { lastErrorCode: outcome.code });
      await auditPublish(run, subject, 'post_variant.publish_failed', { errorCode: outcome.code });
      await rollUpPost(subject.postId);

      // Some failures are about the post; two may be about the connection, and
      // the health check is what finds out which (T1.7, D-114).
      await checkAccountAfterCredentialFailure(run, subject, outcome.code, outcome.clientStanding);
      await raiseNotification(run, subject, 'publishing.failed');

      return { kind: 'FAILED', variantId: subject.variantId, reason: outcome.code };
    }

    case 'INCONCLUSIVE':
    case 'AMBIGUOUS': {
      // Parked. A human decides; nothing automated touches this again.
      await settleClaim(run.claim, {
        status: 'NEEDS_REVIEW',
        lastError: {
          code: 'PUBLISHING_TIMEOUT',
          message:
            'reason' in outcome ? outcome.reason : 'We could not confirm whether this published.',
        },
      });
      await updateJobState(run.publishingJobId, 'DEAD_LETTER', {
        lastErrorCode: 'PUBLISHING_TIMEOUT',
      });
      await auditPublish(run, subject, 'post_variant.publish_inconclusive', {
        reason: 'reason' in outcome ? outcome.reason : outcome.code,
      });
      await rollUpPost(subject.postId);

      logger.error('publish outcome could not be established; parked for review', {
        variantId: subject.variantId,
        organizationId: run.organizationId,
        postId: subject.postId,
      });

      // Nothing automated will touch this again (decision D-027), so telling
      // someone is the only thing that moves it forward.
      await raiseNotification(run, subject, 'publishing.needs_review');

      return { kind: 'PARKED', variantId: subject.variantId };
    }

    case 'RETRYABLE': {
      // Back to SCHEDULED so the retry can claim it again.
      await releaseClaim(run.claim);
      await updateJobState(run.publishingJobId, 'PENDING', { lastErrorCode: outcome.code });

      return {
        kind: 'DEFERRED',
        variantId: subject.variantId,
        reason: outcome.code,
      };
    }

    default: {
      const exhaustive: never = outcome;
      throw new Error(`Unhandled outcome: ${String(exhaustive)}`);
    }
  }
}

/**
 * Tell someone a publish needs attention (T1.15).
 *
 * Enqueued rather than written inline, for two reasons. Fan-out means reading
 * every membership in the organization and running the policy engine over each
 * — work that has no business sitting on the publish path, where latency is the
 * difference between on time and late. And a notification that cannot be
 * written must never undo a publish outcome that was recorded correctly, which
 * is why this catches rather than throws.
 *
 * The contrast with account health (written inline, T1.7) is deliberate: there
 * the notification must not survive a rolled-back status change, because an
 * account silently marked broken is worse than either half alone. Here the
 * outcome is already durable in `PostVariant.status` and the publishing log; the
 * notification is a prompt, not the record.
 */
async function raiseNotification(
  run: ClaimedRun,
  subject: Pick<PublishSubject, 'variantId'>,
  event: 'publishing.failed' | 'publishing.needs_review',
): Promise<void> {
  try {
    await enqueue('notifications', {
      organizationId: run.organizationId,
      correlationId: run.correlationId,
      event,
      resourceType: 'PostVariant',
      resourceId: subject.variantId,
    });
  } catch (error) {
    logError('could not enqueue a publishing notification', error, {
      variantId: subject.variantId,
      organizationId: run.organizationId,
      event,
    });
  }
}

/**
 * A failed publish that may have been a failed *connection* (T1.7, D-114).
 *
 * Before T1.7 a dead token failed one post, left the account `ACTIVE`, and
 * failed the next post identically while the accounts page reported
 * everything fine. So a credential failure here used to demote the account on
 * the spot.
 *
 * It no longer decides. A refusal of one post is evidence about the post as
 * much as the connection: an X media endpoint, an Instagram container, a
 * Page role on one action each answer 401 or 403 for reasons that leave the
 * account working, and every one of them took a good account out of service
 * and told somebody to reconnect it. What this does now is ask the health
 * check to look at the account at once. That probe renews the token where it
 * can, probes again, and confirms ten minutes later before it marks anything —
 * the one place that decides whether a connection is broken.
 *
 * `accountStatusForErrorCode` still decides what is worth asking about, and a
 * refusal of our app (`clientStanding`) is not. Failures here are logged,
 * never rethrown: the publish outcome is already recorded and correct.
 */
async function checkAccountAfterCredentialFailure(
  run: ClaimedRun,
  subject: PublishSubject,
  code: string,
  clientStanding: boolean | undefined,
): Promise<void> {
  if (!accountStatusForErrorCode(code as ErrorCode)) return;

  /**
   * Some permission failures are about our app, not this connection.
   *
   * TikTok refuses a public post from an unaudited client with a 403 that maps
   * to `PROVIDER_PERMISSION_ERROR`, and the account is fine. Nothing about the
   * account is worth checking.
   */
  if (clientStanding) {
    logger.warn('publish failed on client standing; the account is untouched', {
      socialAccountId: subject.socialAccountId,
      organizationId: run.organizationId,
      variantId: subject.variantId,
      errorCode: code,
    });
    return;
  }

  try {
    // One check per account per confirmation window, however many of its
    // posts fail in it.
    const window = Math.floor(clock.now().getTime() / HEALTH_CONFIRM_DELAY_MS);
    await enqueue(
      'account-health',
      {
        organizationId: run.organizationId,
        correlationId: run.correlationId,
        socialAccountId: subject.socialAccountId,
        trigger: 'publish',
      },
      { jobId: `health-publish-${subject.socialAccountId}-${window}` },
    );

    logger.warn('a publish failed on its credential; the health check will look at the account', {
      socialAccountId: subject.socialAccountId,
      organizationId: run.organizationId,
      variantId: subject.variantId,
      errorCode: code,
    });
  } catch (error) {
    logError('could not ask for a health check after a failed publish', error, {
      socialAccountId: subject.socialAccountId,
      organizationId: run.organizationId,
    });
  }
}

async function auditPublish(
  run: ClaimedRun,
  subject: Pick<PublishSubject, 'variantId' | 'workspaceId' | 'brandId'>,
  action: string,
  after: Record<string, string | number | boolean | undefined>,
): Promise<void> {
  await platformDb.auditLog.create({
    data: {
      organizationId: run.organizationId,
      actorUserId: null,
      actorType: 'WORKER',
      action,
      resourceType: 'PostVariant',
      resourceId: subject.variantId,
      workspaceId: subject.workspaceId,
      brandId: subject.brandId,
      after,
      correlationId: run.correlationId,
    },
  });
}

/** A vetted message per error code. Never a provider payload (SRS §33). */
function safeMessageFor(code: string): string {
  switch (code) {
    case 'PROVIDER_AUTHENTICATION_ERROR':
      return 'The connection to this account has expired. Reconnect it and try again.';
    case 'PROVIDER_PERMISSION_ERROR':
      return 'This account is missing a permission needed to publish.';
    case 'PROVIDER_VALIDATION_ERROR':
      return 'The platform rejected this post. Check the content and try again.';
    case 'PROVIDER_MEDIA_ERROR':
      return 'The platform rejected an attached file.';
    default:
      return 'Publishing failed. See the attempt history for details.';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export { PUBLISH_TIMEOUT_MS, LOCK_TTL_MS };

/**
 * Keep an error's context to flat scalars before it is stored.
 *
 * `AppError.context` is already meant to be non-sensitive — it is what the
 * logger emits — but "meant to be" is not a guarantee when the column outlives
 * the incident and is read back into the product UI. Flattening to strings,
 * numbers and booleans means a nested object cannot ride along, and caps the
 * length so a long provider message cannot turn an attempt row into a payload
 * store.
 */
function scrubMeta(
  context: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!context) return undefined;

  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
    else if (typeof value === 'string') safe[key] = value.slice(0, 300);
  }

  return Object.keys(safe).length > 0 ? safe : undefined;
}
