import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { serverEnv } from '@orbit/config';
import { type IdentityProvider, type VerifiedIdentity, unauthenticated } from './identity.js';

/**
 * Firebase Auth identity provider (SRS §51).
 *
 * Everything here runs server-side. The Admin SDK service account never
 * reaches the browser, and no token material is ever logged or returned.
 */

let cached: Auth | undefined;

function adminAuth(): Auth {
  if (cached) return cached;

  const env = serverEnv();
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new Error(
      'Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.',
    );
  }

  const existing = getApps();
  const app: App =
    existing[0] ??
    initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        privateKey: env.FIREBASE_PRIVATE_KEY,
      }),
      projectId: env.FIREBASE_PROJECT_ID,
    });

  cached = getAuth(app);
  return cached;
}

function toIdentity(claims: {
  uid: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  auth_time: number;
  firebase?: { sign_in_provider?: string };
}): VerifiedIdentity {
  if (!claims.email) {
    // Every sign-in method we enable yields an email. Without one there is no
    // way to map the identity to a User row or an invitation.
    unauthenticated('token carries no email address');
  }

  return {
    uid: claims.uid,
    email: claims.email.toLowerCase(),
    emailVerified: claims.email_verified ?? false,
    name: claims.name,
    picture: claims.picture,
    authTime: claims.auth_time,
    signInProvider: claims.firebase?.sign_in_provider,
  };
}

export const firebaseIdentityProvider: IdentityProvider = {
  kind: 'firebase',

  async verifyIdToken(idToken) {
    try {
      // checkRevoked: a token issued before a password change or an explicit
      // sign-out must not be exchangeable for a session.
      const decoded = await adminAuth().verifyIdToken(idToken, true);
      return toIdentity(decoded);
    } catch (error) {
      unauthenticated('id token verification failed', error);
    }
  },

  async createSessionCookie(idToken, expiresInMs) {
    try {
      return await adminAuth().createSessionCookie(idToken, { expiresIn: expiresInMs });
    } catch (error) {
      unauthenticated('session cookie creation failed', error);
    }
  },

  async verifySessionCookie(cookie) {
    try {
      const decoded = await adminAuth().verifySessionCookie(cookie, true);
      return toIdentity(decoded);
    } catch (error) {
      unauthenticated('session cookie verification failed', error);
    }
  },

  async revokeSessions(uid) {
    await adminAuth().revokeRefreshTokens(uid);
  },
};
