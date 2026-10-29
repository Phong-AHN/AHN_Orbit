import { describe, expect, it } from 'vitest';

// Before the module reads the environment: the page exists only with a code.
process.env.GOOGLE_REVIEW_ACCESS_CODE = 'review-code-0123456789';

const { accessCodeMatches, issueState, openSession, reviewEnabled, sealSession, stateIsValid } =
  await import('./session');

/**
 * The gates on the public Google review page. It uploads to a YouTube channel
 * with no Orbit login, so these are the whole of its protection.
 */
describe('google review session', () => {
  it('is open only with the configured access code', () => {
    expect(reviewEnabled()).toBe(true);
    expect(accessCodeMatches('review-code-0123456789')).toBe(true);
    expect(accessCodeMatches(' review-code-0123456789 ')).toBe(true);
    expect(accessCodeMatches('review-code-012345678')).toBe(false);
    expect(accessCodeMatches('')).toBe(false);
  });

  it('accepts its own state only with the matching nonce cookie', () => {
    const { state, nonce } = issueState();
    expect(stateIsValid(state, nonce)).toBe(true);
    expect(stateIsValid(state, undefined)).toBe(false);
    expect(stateIsValid(state, issueState().nonce)).toBe(false);
  });

  it('refuses a state whose payload was altered', () => {
    const { state, nonce } = issueState();
    const [, signature] = state.split('.');
    const forged = `${Buffer.from(JSON.stringify({ nonce, exp: Date.now() + 1e9 })).toString('base64url')}.${signature}`;
    expect(stateIsValid(forged, nonce)).toBe(false);
  });

  it('seals the token so only this page can read it, and drops it once expired', () => {
    const sealed = sealSession({
      accessToken: 'ya29.secret',
      expiresAt: Date.now() + 60_000,
      scopes: ['https://www.googleapis.com/auth/youtube.upload'],
    });
    expect(sealed).not.toContain('ya29');
    expect(openSession(sealed)?.accessToken).toBe('ya29.secret');
    expect(openSession(`${sealed}x`)).toBeNull();

    const expired = sealSession({ accessToken: 't', expiresAt: Date.now() - 1, scopes: [] });
    expect(openSession(expired)).toBeNull();
  });
});
