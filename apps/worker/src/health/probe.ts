import {
  NotFoundError,
  accountStatusForErrorCode,
  clock,
  isAppError,
  isProbeDue,
  HEALTH_PROBE_INTERVAL_MS,
  type HealthChange,
  type SocialAccountStatus,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { logger, logError } from '@orbit/observability';
import { healthRateLimitKey, takeToken } from '@orbit/queue';
import { getProvider } from '@orbit/providers';
import { loadAccountCredential } from '../credentials.js';
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
  | { kind: 'DEFERRED'; retryAfterMs: number };

export interface ProbeInput {
  ctx: TenantContext;
  socialAccountId: string;
  correlationId: string;
  /**
   * Minimum age of the last verdict before re-probing. The sweep passes the
   * hourly interval; a person asking for a check explicitly passes 0.
   */
  minIntervalMs?: number;
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

  const credential = await loadAccountCredential(input.ctx, account.id);
  const provider = getProvider(account.platform);

  let verdict: { status: SocialAccountStatus; message?: string; scopes?: readonly string[] };

  try {
    const health = await provider.probeHealth(credential, { externalId: account.externalId });
    verdict = {
      status: health.status,
      ...(health.message !== undefined ? { message: health.message } : {}),
      scopes: health.grantedScopes,
    };
  } catch (error) {
    // The distinction that matters. An error that *means* the credential is no
    // longer good is a verdict; anything else — a timeout, a 500, a network
    // blip — says nothing about the account and must not demote it. Marking
    // every account NEEDS_RECONNECT during a five-minute Meta outage would send
    // a reconnect prompt to every client for no reason.
    const code = isAppError(error) ? error.code : null;
    const demotedTo = code ? accountStatusForErrorCode(code) : null;

    if (!demotedTo) {
      logError('health probe failed transiently; leaving the account as it is', error, {
        socialAccountId: account.id,
        organizationId: input.ctx.organizationId,
      });
      throw error;
    }

    verdict = {
      status: demotedTo,
      message: isAppError(error) ? error.userMessage : 'The connection is no longer valid.',
    };
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
