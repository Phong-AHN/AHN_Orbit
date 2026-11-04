import { clock } from '@orbit/core';
import type { DecryptedCredential, IssuedCredential, SocialProvider } from './types.js';

/**
 * Renewing a credential just before it is used.
 *
 * Every adapter implements `refreshCredential`, and nothing called it: a
 * YouTube token died an hour after connecting, a TikTok one after a day, and
 * the first symptom was a failed publish that demoted the account. X makes it
 * impossible to ignore — its access tokens last two hours.
 *
 * So the place that opens a credential asks first whether it is due, and the
 * adapter decides what "due" means for its platform. This file is that
 * decision, free of storage: the caller holds the row lock and persists what
 * comes back.
 */

/**
 * How close to expiry a credential has to be before the adapter is asked.
 *
 * The longest window any adapter uses (Threads and LinkedIn renew a week out).
 * Inside it the adapter answers `STILL_VALID` without a network call when it
 * is not yet time; outside it nobody is asked, which keeps the Facebook
 * adapter — whose check is a `debug_token` round trip — off the hot path.
 */
export const REFRESH_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/** Whether this credential should be offered to its adapter for renewal. */
export function refreshIsDue(credential: DecryptedCredential, now: Date = clock.now()): boolean {
  if (!credential.expiresAt) return false;
  return credential.expiresAt.getTime() - now.getTime() <= REFRESH_AHEAD_MS;
}

export type RefreshAttempt =
  | { kind: 'UNCHANGED' }
  /** Persist `issued`, then use `credential`. */
  | { kind: 'REFRESHED'; issued: IssuedCredential; credential: DecryptedCredential }
  /** A person has to reconnect. The old credential is used until it fails. */
  | { kind: 'RECONNECT'; reason: string }
  /** The platform could not be reached; the old credential is used. */
  | { kind: 'FAILED'; error: unknown };

/**
 * Ask the adapter to renew, and never throw.
 *
 * A failed renewal is not a reason to stop the work it was in front of: the
 * existing token may well still be valid, and if it is not, the call that uses
 * it fails through the normal path — the one that records the error and, where
 * the error says so, demotes the account.
 */
export async function attemptRefresh(
  provider: SocialProvider,
  credential: DecryptedCredential,
): Promise<RefreshAttempt> {
  try {
    const outcome = await provider.refreshCredential(credential);
    if (outcome.status === 'STILL_VALID') return { kind: 'UNCHANGED' };
    if (outcome.status === 'REQUIRES_RECONNECT')
      return { kind: 'RECONNECT', reason: outcome.reason };

    const issued = mergeRefreshed(credential, outcome.credential);
    return {
      kind: 'REFRESHED',
      issued,
      credential: { ...issued, keyVersion: credential.keyVersion },
    };
  } catch (error) {
    return { kind: 'FAILED', error };
  }
}

/**
 * What to store after a refresh.
 *
 * Some platforms rotate the refresh token on every use (X, TikTok) and some
 * never return it again (Google). Keeping the old one when none came back is
 * correct for the second kind and harmless for the first, which always sends
 * a new one. The refresh window is carried over on the same terms.
 */
export function mergeRefreshed(
  previous: DecryptedCredential,
  issued: IssuedCredential,
): IssuedCredential {
  const refreshToken = issued.refreshToken ?? previous.refreshToken;
  const refreshableUntil = issued.refreshableUntil ?? previous.refreshableUntil;

  return {
    accessToken: issued.accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(issued.expiresAt ? { expiresAt: issued.expiresAt } : {}),
    ...(refreshableUntil ? { refreshableUntil } : {}),
    scopes: issued.scopes.length > 0 ? issued.scopes : previous.scopes,
  };
}
