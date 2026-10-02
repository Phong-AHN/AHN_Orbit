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

/**
 * Why the identity provider is not usable, in categories safe to publish.
 *
 * The health endpoint is reachable without a session — it has to be, because
 * the thing it most needs to diagnose is a sign-in that will not work. So what
 * it says must be useful to an operator and useless to everyone else: these
 * four values name the *class* of failure and never a project id, an email, a
 * key, or a provider message.
 */
export type IdentityProbeFailure =
  /** Env vars absent. The server cannot even construct a credential. */
  | 'NOT_CONFIGURED'
  /** Google rejected the service account: wrong project, revoked key, bad PEM. */
  | 'CREDENTIAL_REJECTED'
  /** Credential looks fine; Google could not be reached. */
  | 'UNREACHABLE';

export type IdentityProbeResult = { ok: true } | { ok: false; reason: IdentityProbeFailure };

/**
 * Sort a probe failure into a category.
 *
 * Split out and exported because it is the only part worth testing: it is pure,
 * it has no `@/` import, and the mapping is where this gets quietly wrong. A
 * misfiled error turns "your service account is for the wrong project" into
 * "Google is down", and those send an operator in opposite directions.
 *
 * Firebase reports the same underlying problem through several shapes — a
 * `code`, a wrapped `errorInfo.code`, or only a message — so all three are
 * read.
 */
export function classifyIdentityProbeError(error: unknown): IdentityProbeFailure {
  const parts = [
    (error as { code?: unknown })?.code,
    (error as { errorInfo?: { code?: unknown } })?.errorInfo?.code,
    (error as { message?: unknown })?.message,
  ]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();

  // Checked before the credential patterns: "invalid_grant" also appears when a
  // machine's clock has drifted far enough for the signed JWT to look expired,
  // and that is neither a bad key nor an outage — but it is still Google
  // refusing the credential, which is where an operator should look.
  if (
    parts.includes('invalid-credential') ||
    parts.includes('invalid_grant') ||
    parts.includes('invalid jwt') ||
    parts.includes('pem') ||
    parts.includes('decoder') ||
    parts.includes('project-not-found') ||
    parts.includes('insufficient permission') ||
    parts.includes('unauthorized')
  ) {
    return 'CREDENTIAL_REJECTED';
  }

  return 'UNREACHABLE';
}

/**
 * Can this process actually act as the Firebase Admin?
 *
 * Asks for a user at an address that cannot exist. A `user-not-found` is the
 * **success** case: it means the request was signed, accepted and answered, so
 * the service account works — and it proves that without reading a real user,
 * minting a token, or writing anything.
 *
 * `verifyIdToken` would be the obvious probe and is the wrong one: a malformed
 * token fails locally before any credential is used, so it reports a healthy
 * provider when the service account is broken.
 */
export async function probeIdentityProvider(): Promise<IdentityProbeResult> {
  const env = serverEnv();
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    return { ok: false, reason: 'NOT_CONFIGURED' };
  }

  try {
    // `.invalid` is reserved by RFC 2606 and can never be registered, so this
    // address cannot belong to anyone.
    await adminAuth().getUserByEmail('orbit-health-probe@orbit.invalid');
    // Reaching here would mean the address exists, which is impossible — but a
    // round trip is a round trip, so the provider works.
    return { ok: true };
  } catch (error) {
    const code = [
      (error as { code?: unknown })?.code,
      (error as { errorInfo?: { code?: unknown } })?.errorInfo?.code,
    ].find((part): part is string => typeof part === 'string');

    if (code?.includes('user-not-found') || code?.includes('email-already-exists')) {
      return { ok: true };
    }

    return { ok: false, reason: classifyIdentityProbeError(error) };
  }
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
