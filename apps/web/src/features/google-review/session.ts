import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@orbit/config';
import { CredentialCipher } from '@orbit/providers';

/**
 * The Google verification review page (`/review/youtube`).
 *
 * Google's reviewers must be able to exercise the YouTube integration — see the
 * consent screen, connect a channel, upload a video — without an Orbit account.
 * This is that path, built so that it cannot be anything more:
 *
 * - **Off unless `GOOGLE_REVIEW_ACCESS_CODE` is set**, and behind that code,
 *   compared in constant time. The code goes to Google in the reply email.
 * - **Nothing is stored.** The token Google issues lives only in an encrypted,
 *   HTTP-only cookie scoped to `/review`, for thirty minutes. No tenant, no
 *   database row, no queue job. Disconnecting revokes it with Google.
 * - **The same scopes as the product**, because the authorization URL comes
 *   from the same YouTube adapter — which is exactly what the review checks.
 *
 * The state that carries the reviewer through Google is signed with the same
 * secret as the product's OAuth state, and bound to a nonce cookie.
 */

export const REVIEW_BASE_PATH = '/review/youtube';
export const REVIEW_COOKIE_PATH = '/review';
export const REVIEW_SESSION_COOKIE = '__orbit_review';
export const REVIEW_STATE_COOKIE = '__orbit_review_state';
export const REVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

/** The largest file the review page accepts: under Vercel's request-body limit. */
export const REVIEW_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** The page exists only while a code is configured. */
export function reviewEnabled(): boolean {
  return Boolean(serverEnv().GOOGLE_REVIEW_ACCESS_CODE);
}

export function accessCodeMatches(candidate: string): boolean {
  const expected = serverEnv().GOOGLE_REVIEW_ACCESS_CODE;
  if (!expected) return false;
  const a = Buffer.from(candidate.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function reviewRedirectUri(): string {
  return `${serverEnv().APP_URL.replace(/\/$/, '')}${REVIEW_BASE_PATH}/callback`;
}

// ── State, through Google and back ──────────────────────────────────────────

function sign(payload: string): string {
  return createHmac('sha256', Buffer.from(serverEnv().STATE_SIGNING_SECRET, 'base64'))
    .update(`google-review:${payload}`)
    .digest('base64url');
}

export function issueState(): { state: string; nonce: string } {
  const nonce = randomBytes(24).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ nonce, exp: Date.now() + STATE_TTL_MS })).toString(
    'base64url',
  );
  return { state: `${payload}.${sign(payload)}`, nonce };
}

export function stateIsValid(state: string, nonceCookie: string | undefined): boolean {
  const [payload, signature] = state.split('.');
  if (!payload || !signature || !nonceCookie) return false;

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;

  try {
    const { nonce, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      nonce?: string;
      exp?: number;
    };
    if (!nonce || !exp || exp < Date.now()) return false;
    const a = Buffer.from(nonce);
    const b = Buffer.from(nonceCookie);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── The session cookie ──────────────────────────────────────────────────────

export interface ReviewSession {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

/** Bound to its purpose, so a value sealed here opens nowhere else. */
const AAD = { organizationId: 'google-review', socialAccountId: 'session' };

export function sealSession(session: ReviewSession): string {
  const sealed = new CredentialCipher().seal(JSON.stringify(session), AAD);
  return [sealed.keyVersion, sealed.iv, sealed.authTag, sealed.ciphertext]
    .map((part) =>
      typeof part === 'number' ? String(part) : Buffer.from(part).toString('base64url'),
    )
    .join('.');
}

export function openSession(value: string | undefined): ReviewSession | null {
  if (!value) return null;
  const [keyVersion, iv, authTag, ciphertext] = value.split('.');
  if (!keyVersion || !iv || !authTag || !ciphertext) return null;

  try {
    const session = JSON.parse(
      new CredentialCipher().open(
        {
          keyVersion: Number(keyVersion),
          iv: Buffer.from(iv, 'base64url'),
          authTag: Buffer.from(authTag, 'base64url'),
          ciphertext: Buffer.from(ciphertext, 'base64url'),
        },
        AAD,
      ),
    ) as ReviewSession;
    return session.expiresAt > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: serverEnv().APP_ENV === 'production',
    sameSite: 'lax' as const,
    path: REVIEW_COOKIE_PATH,
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}
