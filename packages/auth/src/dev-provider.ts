import { createHmac, timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@orbit/config';
import { clock } from '@orbit/core';
import { logger } from '@orbit/observability';
import { type IdentityProvider, type VerifiedIdentity, unauthenticated } from './identity.js';

/**
 * Development-only identity provider.
 *
 * Exists so the application can be built and tested before a Firebase project
 * is provisioned. It issues a genuine HMAC-signed session cookie and goes
 * through the same verification path as production, so what gets exercised
 * locally is the real flow rather than a bypass around it.
 *
 * It is fenced in three independent ways:
 *   1. `assertDevelopmentOnly()` throws if APP_ENV or NODE_ENV is production;
 *   2. `selectIdentityProvider()` only chooses it when Firebase is unconfigured
 *      AND the environment is non-production;
 *   3. a test asserts both of the above.
 *
 * ID token format: `dev:<email>` — matching the `dev:` prefixed firebaseUid the
 * seed writes, so seeded users sign in without any special casing.
 */

export function assertDevelopmentOnly(): void {
  const env = serverEnv();
  if (env.APP_ENV === 'production' || env.NODE_ENV === 'production') {
    throw new Error(
      'The development identity provider must never be used in production. ' +
        'Configure FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.',
    );
  }
}

const DEV_TOKEN_PREFIX = 'dev:';

/**
 * In-memory revocation registry. Single-process only, which is fine for local
 * development and is one of several reasons this provider is not production
 * code — Firebase revocation is durable and cluster-wide.
 */
const revokedBefore = new Map<string, number>();

function signingKey(): Buffer {
  return Buffer.from(serverEnv().STATE_SIGNING_SECRET, 'base64');
}

function sign(payload: string): string {
  return createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

interface DevCookiePayload {
  uid: string;
  email: string;
  iat: number;
  exp: number;
}

export const devIdentityProvider: IdentityProvider = {
  kind: 'development',

  async verifyIdToken(idToken) {
    assertDevelopmentOnly();

    if (!idToken.startsWith(DEV_TOKEN_PREFIX)) {
      unauthenticated('development id token must be of the form dev:<email>');
    }

    const email = idToken.slice(DEV_TOKEN_PREFIX.length).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      unauthenticated('development id token carries no usable email');
    }

    logger.warn('development identity provider used', { email, provider: 'development' });

    return {
      // Matches the seed's `dev:<email>` firebaseUid.
      uid: `${DEV_TOKEN_PREFIX}${email}`,
      email,
      emailVerified: true,
      authTime: Math.floor(clock.nowMs() / 1000),
      signInProvider: 'development',
    } satisfies VerifiedIdentity;
  },

  async createSessionCookie(idToken, expiresInMs) {
    assertDevelopmentOnly();
    const identity = await devIdentityProvider.verifyIdToken(idToken);

    const payload: DevCookiePayload = {
      uid: identity.uid,
      email: identity.email,
      iat: clock.nowMs(),
      exp: clock.nowMs() + expiresInMs,
    };

    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${body}.${sign(body)}`;
  },

  async verifySessionCookie(cookie) {
    assertDevelopmentOnly();

    const [body, signature] = cookie.split('.');
    if (!body || !signature) unauthenticated('malformed development session cookie');

    const expected = sign(body);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      unauthenticated('development session cookie signature mismatch');
    }

    let payload: DevCookiePayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as DevCookiePayload;
    } catch (error) {
      unauthenticated('development session cookie payload is not readable', error);
    }

    if (typeof payload.exp !== 'number' || payload.exp <= clock.nowMs()) {
      unauthenticated('development session cookie expired');
    }

    const revokedAt = revokedBefore.get(payload.uid);
    if (revokedAt !== undefined && payload.iat <= revokedAt) {
      unauthenticated('development session revoked');
    }

    return {
      uid: payload.uid,
      email: payload.email,
      emailVerified: true,
      authTime: Math.floor(payload.iat / 1000),
      signInProvider: 'development',
    } satisfies VerifiedIdentity;
  },

  async revokeSessions(uid) {
    assertDevelopmentOnly();
    revokedBefore.set(uid, clock.nowMs());
  },
};

/** Test seam so revocation state does not leak between test files. */
export function resetDevSessions(): void {
  revokedBefore.clear();
}
