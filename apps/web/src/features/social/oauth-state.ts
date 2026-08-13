import { createHmac, timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@orbit/config';
import { UnauthenticatedError, ValidationError, clock, newOpaqueToken } from '@orbit/core';
import type { Platform } from '@orbit/core';

/**
 * OAuth `state` — CSRF protection for the connect flow (SRS §6).
 *
 * The threat is an attacker completing *their* OAuth flow inside *your*
 * session, so that their account gets connected to your organization. Four
 * things make that fail:
 *
 *  1. **Signed.** HMAC-SHA256 over the payload, so state cannot be forged.
 *  2. **Session-bound.** The payload names the user who began the flow; the
 *     callback rejects a mismatch against the session.
 *  3. **Single-use.** A nonce is mirrored into an HttpOnly cookie and cleared
 *     on callback, so a captured state cannot be replayed.
 *  4. **Time-boxed.** Ten minutes, which is longer than any real consent flow
 *     and shorter than an attacker's convenience.
 *
 * The cookie carries only the nonce; everything else is inside the signed
 * payload, so the two must agree for the callback to proceed.
 */

export const OAUTH_STATE_COOKIE = '__orbit_oauth';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStatePayload {
  /** Mirrored into the cookie; makes the state single-use. */
  nonce: string;
  platform: Platform;
  organizationId: string;
  workspaceId: string;
  brandId: string;
  /** Who began the flow. The callback re-checks this against the session. */
  userId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Where to send the browser once the connection completes. */
  returnTo?: string | undefined;
}

function signingKey(): Buffer {
  return Buffer.from(serverEnv().STATE_SIGNING_SECRET, 'base64');
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

export interface IssuedState {
  /** Opaque value handed to the provider. */
  state: string;
  /** Value for the HttpOnly cookie. */
  nonce: string;
}

export function issueOAuthState(
  input: Omit<OAuthStatePayload, 'nonce' | 'expiresAt'>,
): IssuedState {
  const nonce = newOpaqueToken(24);
  const payload: OAuthStatePayload = {
    ...input,
    nonce,
    expiresAt: clock.nowMs() + OAUTH_STATE_TTL_MS,
  };

  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { state: `${encoded}.${sign(encoded)}`, nonce };
}

export interface VerifyStateInput {
  state: string | null | undefined;
  /** Nonce from the HttpOnly cookie set when the flow began. */
  cookieNonce: string | null | undefined;
  /** The currently authenticated user. */
  sessionUserId: string;
  /** Organization from the URL the callback landed on, if any. */
  expectedOrganizationId?: string | undefined;
}

/**
 * Verify a callback's state, or throw.
 *
 * Every failure produces the same generic message: an attacker learns nothing
 * about which check failed. The specific reason goes to the log as a security
 * event.
 */
export function verifyOAuthState(input: VerifyStateInput): OAuthStatePayload {
  const reject = (reason: string): never => {
    throw new ValidationError('OAuth state verification failed', {
      userMessage: 'That connection link is no longer valid. Please start again.',
      context: { securityEvent: true, reason },
    });
  };

  if (!input.state) reject('missing state');
  if (!input.cookieNonce) reject('missing state cookie');

  const [encoded, signature] = input.state!.split('.');
  if (!encoded || !signature) reject('malformed state');

  const expected = sign(encoded!);
  const a = Buffer.from(signature!);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) reject('signature mismatch');

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8')) as OAuthStatePayload;
  } catch {
    return reject('unreadable payload');
  }

  if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= clock.nowMs()) {
    reject('expired');
  }

  // Single use: the cookie is cleared on callback, so a replayed state has no
  // matching nonce.
  const nonceA = Buffer.from(payload.nonce ?? '');
  const nonceB = Buffer.from(input.cookieNonce!);
  if (nonceA.length !== nonceB.length || !timingSafeEqual(nonceA, nonceB)) {
    reject('nonce mismatch');
  }

  // Session binding: the person finishing the flow must be the one who began
  // it. This is what stops an attacker's consent landing in your organization.
  if (payload.userId !== input.sessionUserId) {
    throw new UnauthenticatedError('OAuth state belongs to a different session', {
      context: { securityEvent: true, reason: 'session mismatch' },
    });
  }

  if (input.expectedOrganizationId && payload.organizationId !== input.expectedOrganizationId) {
    reject('organization mismatch');
  }

  return payload;
}

export function oauthStateCookie(nonce: string) {
  return {
    name: OAUTH_STATE_COOKIE,
    value: nonce,
    httpOnly: true as const,
    secure: !serverEnv().APP_URL.startsWith('http://localhost'),
    // The provider redirects back via a top-level GET, which Lax permits.
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(OAUTH_STATE_TTL_MS / 1000),
  };
}

export function clearedOAuthStateCookie() {
  return { ...oauthStateCookie(''), maxAge: 0 };
}
