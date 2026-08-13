import { UnauthenticatedError } from '@orbit/core';

/**
 * Identity provider abstraction (decision D-004).
 *
 * Firebase Auth owns *identity* — credentials, email verification, password
 * reset, Google sign-in, and later MFA. It owns nothing else: roles and
 * memberships live in Postgres and are re-read on every request.
 *
 * The interface exists so the Firebase dependency stays confined to one module
 * and so local development can run before a Firebase project exists.
 */

export interface VerifiedIdentity {
  /** Stable provider-side identifier. Maps to `User.firebaseUid`. */
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string | undefined;
  picture?: string | undefined;
  /** When the identity was authenticated, epoch seconds. */
  authTime: number;
  signInProvider?: string | undefined;
}

export interface IdentityProvider {
  readonly kind: 'firebase' | 'development';

  /** Verify a client-issued ID token. Throws `UnauthenticatedError` if invalid. */
  verifyIdToken(idToken: string): Promise<VerifiedIdentity>;

  /** Exchange a freshly verified ID token for a long-lived session cookie. */
  createSessionCookie(idToken: string, expiresInMs: number): Promise<string>;

  /**
   * Verify a session cookie, *including* a revocation check. Sign-out and
   * password changes must take effect immediately, not at the next refresh.
   */
  verifySessionCookie(cookie: string): Promise<VerifiedIdentity>;

  /** Invalidate every existing session for this identity. */
  revokeSessions(uid: string): Promise<void>;
}

export function unauthenticated(reason: string, cause?: unknown): never {
  throw new UnauthenticatedError('Authentication failed', {
    // The reason is logged, never returned — telling a caller *why* a token was
    // rejected is a gift to whoever is probing.
    context: { reason },
    cause,
  });
}
