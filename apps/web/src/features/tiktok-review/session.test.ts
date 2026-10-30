import { describe, expect, it } from 'vitest';

// Before the module reads the environment: the page exists only with a code and an app.
process.env.TIKTOK_REVIEW_ACCESS_CODE = 'tiktok-review-0123456789';
process.env.TIKTOK_CLIENT_KEY = 'client-key';
process.env.TIKTOK_CLIENT_SECRET = 'client-secret';

const {
  issueTikTokState,
  openTikTokSession,
  sealTikTokSession,
  tiktokAccessCodeMatches,
  tiktokReviewEnabled,
  tiktokStateIsValid,
} = await import('./session');
const { issueState, stateIsValid } = await import('../google-review/session');

/**
 * The gates on the public TikTok review page. It posts to a TikTok account
 * with no Social Square login, so these are the whole of its protection.
 */
describe('tiktok review session', () => {
  it('is open only with the configured access code', () => {
    expect(tiktokReviewEnabled()).toBe(true);
    expect(tiktokAccessCodeMatches('tiktok-review-0123456789')).toBe(true);
    expect(tiktokAccessCodeMatches('tiktok-review-012345678')).toBe(false);
    expect(tiktokAccessCodeMatches('')).toBe(false);
  });

  it('accepts its own state only with the matching nonce cookie', () => {
    const { state, nonce } = issueTikTokState();
    expect(tiktokStateIsValid(state, nonce)).toBe(true);
    expect(tiktokStateIsValid(state, undefined)).toBe(false);
    expect(tiktokStateIsValid(state, issueTikTokState().nonce)).toBe(false);
  });

  it('does not accept the Google review page’s state, nor the other way round', () => {
    const google = issueState();
    expect(tiktokStateIsValid(google.state, google.nonce)).toBe(false);
    const tiktok = issueTikTokState();
    expect(stateIsValid(tiktok.state, tiktok.nonce)).toBe(false);
  });

  it('seals the token so only this page can read it, and drops it once expired', () => {
    const live = { accessToken: 'act.secret', openId: 'open-1', scopes: ['video.publish'] };
    const sealed = sealTikTokSession({ ...live, expiresAt: Date.now() + 60_000 });
    expect(sealed).not.toContain('act.secret');
    expect(openTikTokSession(sealed)?.accessToken).toBe('act.secret');
    const parts = sealed.split('.');
    const tag = parts[2]!;
    parts[2] = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;
    expect(openTikTokSession(parts.join('.'))).toBeNull();
    expect(openTikTokSession(sealTikTokSession({ ...live, expiresAt: Date.now() - 1 }))).toBeNull();
  });
});

describe('tiktok review unlock', () => {
  it('is valid only as issued, and only until it expires', async () => {
    const { issueTikTokUnlock, tiktokUnlockIsValid } = await import('./session');
    const unlock = issueTikTokUnlock();
    expect(tiktokUnlockIsValid(unlock)).toBe(true);
    expect(tiktokUnlockIsValid(undefined)).toBe(false);
    expect(tiktokUnlockIsValid(issueTikTokUnlock(Date.now() - 31 * 60 * 1000))).toBe(false);

    const [, signature] = unlock.split('.');
    const forever = Buffer.from(JSON.stringify({ exp: Date.now() + 1e12 })).toString('base64url');
    expect(tiktokUnlockIsValid(`${forever}.${signature}`)).toBe(false);

    // A state is not an unlock, though both are signed with the same secret.
    const { state } = issueTikTokState();
    expect(tiktokUnlockIsValid(state)).toBe(false);
  });
});
