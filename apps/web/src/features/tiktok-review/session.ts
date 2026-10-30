import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@orbit/config';
import { CredentialCipher } from '@orbit/providers';

/**
 * The TikTok app review page (`/review/tiktok`), on the same model as
 * `/review/youtube` (`features/google-review/session.ts`).
 *
 * TikTok's reviewers must exercise Login Kit and the Content Posting API —
 * authorize, see the creator's options, post a video — without a Social Square
 * account. Built so it cannot be anything more:
 *
 * - **Off unless `TIKTOK_REVIEW_ACCESS_CODE` is set**, and behind that code,
 *   compared in constant time.
 * - **Nothing is stored.** The token lives only in an encrypted, HTTP-only
 *   cookie scoped to `/review/tiktok`, for thirty minutes. No tenant, no
 *   database row, no job. Disconnecting revokes it with TikTok.
 * - **The same scopes as the product**: the authorization URL comes from the
 *   TikTok adapter itself.
 */

export const TIKTOK_REVIEW_PATH = '/review/tiktok';
export const TIKTOK_REVIEW_SESSION_COOKIE = '__orbit_tiktok_review';
export const TIKTOK_REVIEW_STATE_COOKIE = '__orbit_tiktok_review_state';
export const TIKTOK_REVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

/** Under Vercel's request-body limit, and under TikTok's single-chunk ceiling. */
export const TIKTOK_REVIEW_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export function tiktokReviewEnabled(): boolean {
  const env = serverEnv();
  return Boolean(
    env.TIKTOK_REVIEW_ACCESS_CODE && env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET,
  );
}

export function tiktokAccessCodeMatches(candidate: string): boolean {
  const expected = serverEnv().TIKTOK_REVIEW_ACCESS_CODE;
  if (!expected) return false;
  const a = Buffer.from(candidate.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function tiktokReviewRedirectUri(): string {
  return `${serverEnv().APP_URL.replace(/\/$/, '')}${TIKTOK_REVIEW_PATH}/callback`;
}

// ── State, through TikTok and back ──────────────────────────────────────────

function sign(payload: string): string {
  return createHmac('sha256', Buffer.from(serverEnv().STATE_SIGNING_SECRET, 'base64'))
    .update(`tiktok-review:${payload}`)
    .digest('base64url');
}

export function issueTikTokState(): { state: string; nonce: string } {
  const nonce = randomBytes(24).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ nonce, exp: Date.now() + STATE_TTL_MS })).toString(
    'base64url',
  );
  return { state: `${payload}.${sign(payload)}`, nonce };
}

export function tiktokStateIsValid(state: string, nonceCookie: string | undefined): boolean {
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

export interface TikTokReviewSession {
  accessToken: string;
  openId: string;
  expiresAt: number;
  scopes: string[];
}

/** Bound to its purpose, so a value sealed here opens nowhere else. */
const AAD = { organizationId: 'tiktok-review', socialAccountId: 'session' };

export function sealTikTokSession(session: TikTokReviewSession): string {
  const sealed = new CredentialCipher().seal(JSON.stringify(session), AAD);
  return [sealed.keyVersion, sealed.iv, sealed.authTag, sealed.ciphertext]
    .map((part) =>
      typeof part === 'number' ? String(part) : Buffer.from(part).toString('base64url'),
    )
    .join('.');
}

export function openTikTokSession(value: string | undefined): TikTokReviewSession | null {
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
    ) as TikTokReviewSession;
    return session.expiresAt > Date.now() ? session : null;
  } catch {
    return null;
  }
}

export function tiktokCookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: serverEnv().APP_ENV === 'production',
    sameSite: 'lax' as const,
    path: TIKTOK_REVIEW_PATH,
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}
