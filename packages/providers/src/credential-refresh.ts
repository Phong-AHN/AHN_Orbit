import {
  ProviderAuthenticationError,
  ProviderUnavailableError,
  clock,
  isAppError,
  isClientStandingFailure,
  type Platform,
} from '@orbit/core';
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
 * How close to expiry counts as expired.
 *
 * The call a credential is opened for takes time — a video upload takes
 * minutes — so a token with seconds left is as good as gone.
 */
export const EXPIRY_MARGIN_MS = 60_000;

/** Whether the access token is expired, or about to be. */
export function isExpired(credential: DecryptedCredential, now: Date = clock.now()): boolean {
  if (!credential.expiresAt) return false;
  return credential.expiresAt.getTime() - now.getTime() <= EXPIRY_MARGIN_MS;
}

/**
 * The credential a caller should use after a renewal was attempted — or the
 * error to raise instead of using one that cannot work.
 *
 * ## Why this exists: the disconnections that were not
 *
 * A renewal that did not succeed used to hand back the stored credential
 * regardless, on the reasoning that it might still be valid. When it had
 * already expired that guaranteed a 401 from the platform, the 401 read as
 * "this account's token is dead", and the account was marked NEEDS_RECONNECT —
 * for a network blip at the token endpoint, a database lock that timed out, or
 * a wrong client secret on one worker. X tokens last two hours and Google's
 * one, so for those platforms any hiccup in renewal became a disconnection,
 * and the next renewal that worked brought the account back: an account that
 * flapped between broken and fine.
 *
 * Now an expired credential is never used:
 *
 * - **renewed** → the new one;
 * - **not due**, or **still valid** whatever happened → the stored one, which
 *   works;
 * - **refused by the platform** (`RECONNECT`) → an authentication error that
 *   says why, because only a person can fix that;
 * - **anything else** → a retryable unavailable error. Nothing is learned about
 *   the account, so nothing is said about it; the work is tried again later.
 *   A refusal of our own app keeps its `clientStanding` flag, so no account is
 *   demoted for it.
 */
export function settleRenewal(
  platform: Platform,
  current: DecryptedCredential,
  attempt: RefreshAttempt,
  now: Date = clock.now(),
): DecryptedCredential {
  if (attempt.kind === 'REFRESHED') return attempt.credential;
  if (attempt.kind === 'UNCHANGED' || !isExpired(current, now)) return current;

  if (attempt.kind === 'RECONNECT') {
    throw new ProviderAuthenticationError(`The ${platform} credential could not be renewed`, {
      userMessage: attempt.reason,
      context: { platform, credentialRenewal: 'REFUSED' },
    });
  }

  if (isAppError(attempt.error) && isClientStandingFailure(attempt.error)) throw attempt.error;

  throw new ProviderUnavailableError(
    `The ${platform} credential has expired and could not be renewed just now`,
    {
      userMessage: 'The connection could not be renewed just now. Social Square will try again.',
      context: {
        platform,
        credentialRenewal: 'FAILED',
        ...(isAppError(attempt.error) ? { renewalError: attempt.error.code } : {}),
      },
      cause: attempt.error,
    },
  );
}

/**
 * The same credential, presented to its adapter as already expired.
 *
 * For a renewal that has to happen now whatever the stored expiry says: a
 * platform that answered 401 to a token it issued an hour ago has withdrawn
 * it early, and the refresh token may still be good. Only a credential with a
 * refresh token qualifies — the platforms that renew with the access token
 * itself (Meta's) cannot renew one that has stopped working.
 */
export function asDueForRenewal(credential: DecryptedCredential): DecryptedCredential | null {
  if (!credential.refreshToken) return null;
  return { ...credential, expiresAt: new Date(0) };
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
