import {
  NotFoundError,
  accountStatusForErrorCode,
  brokenVerdictStep,
  isClientStandingFailure,
  clock,
  isAppError,
  isProbeDue,
  HEALTH_CONFIRM_DELAY_MS,
  HEALTH_PROBE_INTERVAL_MS,
  type HealthChange,
  type SocialAccountStatus,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { logger, logError } from '@orbit/observability';
import { enqueue, healthRateLimitKey, takeToken } from '@orbit/queue';
import { getProvider, type DecryptedCredential, type SocialProvider } from '@orbit/providers';
import { loadAccountCredential, renewNow } from '../credentials.js';
import { recordHealthVerdict } from './record.js';

/**
 * Probing one account against its platform (T1.7).
 *
 * Health is established by **asking**, because a Facebook Page token generally
 * carries no expiry and yet dies silently when the granting user changes their
 * password or loses access (docs/SOCIAL_PROVIDERS.md §4). An expiry check would
 * report "healthy" right up to the first failed publish.
 */

/**
 * The probe's own token bucket, separate from publishing's (decision D-031).
 *
 * Small on purpose: one probe per account per hour is the steady state, so this
 * only has to absorb retries and a manual check happening near a sweep.
 */
const HEALTH_RATE_LIMIT = { capacity: 3, refillWindowMs: 60_000 };

export type ProbeResult =
  | { kind: 'PROBED'; status: SocialAccountStatus; change: HealthChange }
  | { kind: 'SKIPPED'; reason: 'NOT_DUE' | 'NOT_CONNECTED' }
  | { kind: 'DEFERRED'; retryAfterMs: number }
  /** Found broken once; a second probe decides (D-114). Nothing was recorded. */
  | { kind: 'CONFIRMING'; confirmAt: Date };

export interface ProbeInput {
  ctx: TenantContext;
  socialAccountId: string;
  correlationId: string;
  /**
   * Minimum age of the last verdict before re-probing. The sweep passes the
   * hourly interval; a person asking for a check explicitly passes 0.
   */
  minIntervalMs?: number;
  /**
   * This probe is the second look at a connection an earlier one found
   * broken. Its finding is recorded; a first finding only asks for this one.
   */
  confirmation?: boolean;
}

export async function probeAccount(input: ProbeInput): Promise<ProbeResult> {
  const now = clock.now();

  const account = await withTenant(input.ctx, (db) =>
    db.socialAccount.findFirst({
      where: { id: input.socialAccountId, deletedAt: null },
      select: {
        id: true,
        platform: true,
        externalId: true,
        status: true,
        healthCheckedAt: true,
      },
    }),
  );

  if (!account) throw new NotFoundError('Social account');

  // DISABLED is a row staged mid-OAuth and REVOKED is a deliberate
  // disconnection. Neither is a connection anyone expects to work, so probing
  // would spend quota to confirm something we already know.
  if (account.status === 'DISABLED' || account.status === 'REVOKED') {
    return { kind: 'SKIPPED', reason: 'NOT_CONNECTED' };
  }

  // Re-checked here and not only in the sweep: a job can sit behind a backlog or
  // be retried, and by the time it runs someone may have probed from the UI.
  if (!isProbeDue(account.healthCheckedAt, now, input.minIntervalMs ?? HEALTH_PROBE_INTERVAL_MS)) {
    return { kind: 'SKIPPED', reason: 'NOT_DUE' };
  }

  const token = await takeToken(
    healthRateLimitKey(account.platform, account.id),
    HEALTH_RATE_LIMIT,
  );

  if (!token.allowed) {
    // Health is not urgent. Coming back later costs nothing, and the publish
    // path never trusts a stale verdict anyway — it fails on the live call.
    return { kind: 'DEFERRED', retryAfterMs: token.retryAfterMs };
  }

  const provider = getProvider(account.platform);

  let verdict: Verdict;
  try {
    verdict = await probeWithRenewal(input.ctx, account, provider);
  } catch (error) {
    // Says nothing about the account: a timeout, a 500, a network blip, a
    // renewal that could not be made just now, or a refusal of our app as a
    // whole. Marking every account NEEDS_RECONNECT during a five-minute Meta
    // outage would send a reconnect prompt to every client for no reason.
    logError('health probe failed transiently; leaving the account as it is', error, {
      socialAccountId: account.id,
      organizationId: input.ctx.organizationId,
      platform: account.platform,
    });
    throw error;
  }

  if (
    verdict.status === 'NEEDS_RECONNECT' &&
    brokenVerdictStep({
      currentStatus: account.status,
      confirmation: input.confirmation === true,
    }) === 'CONFIRM_LATER'
  ) {
    const confirmAt = new Date(now.getTime() + HEALTH_CONFIRM_DELAY_MS);

    // One confirmation per account per hour, however many first findings.
    await enqueue(
      'account-health',
      {
        organizationId: input.ctx.organizationId,
        correlationId: input.correlationId,
        socialAccountId: account.id,
        trigger: 'confirm',
      },
      {
        jobId: `health-confirm-${account.id}-${Math.floor(now.getTime() / HEALTH_PROBE_INTERVAL_MS)}`,
        delayMs: HEALTH_CONFIRM_DELAY_MS,
      },
    );

    logger.warn('health probe found a connection broken once; confirming before saying so', {
      socialAccountId: account.id,
      organizationId: input.ctx.organizationId,
      platform: account.platform,
      reason: verdict.message,
      confirmAt: confirmAt.toISOString(),
    });

    return { kind: 'CONFIRMING', confirmAt };
  }

  const change = await recordHealthVerdict({
    ctx: input.ctx,
    socialAccountId: account.id,
    correlationId: input.correlationId,
    source: 'health-probe',
    verdict: {
      status: verdict.status,
      checkedAt: clock.now(),
      ...(verdict.message !== undefined ? { message: verdict.message } : {}),
      ...(verdict.scopes !== undefined ? { grantedScopes: verdict.scopes } : {}),
    },
  });

  if (change.degraded) {
    logger.warn('account health probe found a broken connection', {
      socialAccountId: account.id,
      organizationId: input.ctx.organizationId,
      platform: account.platform,
    });
  }

  return { kind: 'PROBED', status: verdict.status, change };
}

// ── One look at the connection ──────────────────────────────────────────────

interface Verdict {
  status: SocialAccountStatus;
  message?: string;
  scopes?: readonly string[];
}

/**
 * Probe, and before believing a broken verdict, renew and probe once more.
 *
 * A platform that refuses a token it issued an hour ago has usually withdrawn
 * it early (a password change elsewhere, a security sweep, a renewal another
 * process made) and the refresh token is often still good. Asking costs one
 * call; a wrong verdict costs somebody a reconnection. Where there is no
 * refresh token (Meta's platforms renew with the access token itself) the
 * first verdict stands.
 */
async function probeWithRenewal(
  ctx: TenantContext,
  account: { id: string; externalId: string },
  provider: SocialProvider,
): Promise<Verdict> {
  const first = await verdictOf(provider, account, () => loadAccountCredential(ctx, account.id));
  if (first.status !== 'NEEDS_RECONNECT') return first;

  let nothingToRenewWith = false;
  const second = await verdictOf(provider, account, async () => {
    const credential = await renewNow(ctx, account.id);
    nothingToRenewWith = credential === null;
    return credential;
  });

  // Nothing to renew with: the first verdict is the only one there is. A
  // refused renewal is a verdict of its own, and the more exact one.
  return nothingToRenewWith ? first : second;
}

/**
 * One probe as a verdict.
 *
 * Throws only for what says nothing about the account. A credential the
 * platform will not renew is a verdict (`settleRenewal` raises it as an
 * authentication error, with the platform's reason); a renewal that could not
 * be made just now is not.
 */
async function verdictOf(
  provider: SocialProvider,
  account: { externalId: string },
  credential: () => Promise<DecryptedCredential | null>,
): Promise<Verdict> {
  try {
    const opened = await credential();
    // Nothing was renewed; the caller keeps its first verdict.
    if (!opened) return { status: 'NEEDS_RECONNECT' };

    const health = await provider.probeHealth(opened, { externalId: account.externalId });
    return {
      status: health.status,
      ...(health.message !== undefined ? { message: health.message } : {}),
      scopes: health.grantedScopes,
    };
  } catch (error) {
    const code = isAppError(error) ? error.code : null;
    const demotedTo =
      code && !isClientStandingFailure(error) ? accountStatusForErrorCode(code) : null;
    if (!demotedTo) throw error;

    return {
      status: demotedTo,
      message: isAppError(error) ? error.userMessage : 'The connection is no longer valid.',
    };
  }
}
