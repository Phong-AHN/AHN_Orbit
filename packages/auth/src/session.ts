import { serverEnv } from '@orbit/config';
import { UnauthenticatedError } from '@orbit/core';
import { logger } from '@orbit/observability';
import { devIdentityProvider } from './dev-provider.js';
import { firebaseIdentityProvider } from './firebase-provider.js';
import type { IdentityProvider, VerifiedIdentity } from './identity.js';

/**
 * Session handling (T1.1).
 *
 *   Browser signs in with the Firebase client SDK        → ID token
 *   POST /api/v1/auth/session  verifies it server-side   → session cookie
 *   Every later request        verifies the cookie       → VerifiedIdentity
 *
 * The browser never sends a user id or an organization id that the server
 * trusts. Identity comes from the cookie and nothing else; the tenant comes
 * from the URL, cross-checked against memberships in the database.
 */

/**
 * 14 days — the maximum Firebase permits for a session cookie, and long enough
 * that an agency user is not signing in daily. Revocation is immediate
 * regardless, because verification always runs the revocation check.
 */
export const SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = '__orbit_session';

export function selectIdentityProvider(): IdentityProvider {
  const env = serverEnv();
  const firebaseConfigured = Boolean(
    env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY,
  );

  if (firebaseConfigured) return firebaseIdentityProvider;

  if (env.APP_ENV === 'production' || env.NODE_ENV === 'production') {
    // Never silently degrade to the development provider in production.
    throw new Error(
      'Firebase Admin is not configured, and the development identity provider is not permitted in production.',
    );
  }

  return devIdentityProvider;
}

export interface SessionCookieOptions {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
}

/**
 * Cookie attributes.
 *
 * `httpOnly` so script cannot read it; `sameSite=lax` so it is not sent on
 * cross-site POSTs (the CSRF control for state-changing requests) while normal
 * top-level navigation still works; `secure` everywhere except local http.
 */
export function sessionCookie(value: string, maxAgeMs = SESSION_MAX_AGE_MS): SessionCookieOptions {
  return {
    name: SESSION_COOKIE_NAME,
    value,
    httpOnly: true,
    secure: !serverEnv().APP_URL.startsWith('http://localhost'),
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

export function clearedSessionCookie(): SessionCookieOptions {
  return { ...sessionCookie('', 0), maxAge: 0 };
}

/** Exchange a verified ID token for a session cookie. */
export async function createSession(
  idToken: string,
): Promise<{ cookie: SessionCookieOptions; identity: VerifiedIdentity }> {
  const provider = selectIdentityProvider();

  // Verify before minting: an unverified token must never become a session.
  const identity = await provider.verifyIdToken(idToken);
  const value = await provider.createSessionCookie(idToken, SESSION_MAX_AGE_MS);

  logger.info('session created', {
    uid: identity.uid,
    email: identity.email,
    provider: provider.kind,
    signInProvider: identity.signInProvider,
  });

  return { cookie: sessionCookie(value), identity };
}

/**
 * Verify a session cookie value. Returns `null` when absent — callers decide
 * whether that is a 401 or an anonymous render.
 */
export async function readSession(
  cookieValue: string | undefined,
): Promise<VerifiedIdentity | null> {
  if (!cookieValue) return null;
  return selectIdentityProvider().verifySessionCookie(cookieValue);
}

/** Verify a session cookie, or throw `UnauthenticatedError`. */
export async function requireSession(cookieValue: string | undefined): Promise<VerifiedIdentity> {
  if (!cookieValue) {
    throw new UnauthenticatedError('No session cookie present', {
      context: { reason: 'missing session cookie' },
    });
  }
  return selectIdentityProvider().verifySessionCookie(cookieValue);
}

/** Revoke every session for an identity. Sign-out and forced logout both use this. */
export async function revokeSessions(uid: string): Promise<void> {
  await selectIdentityProvider().revokeSessions(uid);
  logger.info('sessions revoked', { uid });
}
