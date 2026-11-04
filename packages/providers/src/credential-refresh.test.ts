import { describe, expect, it } from 'vitest';
import {
  attemptRefresh,
  mergeRefreshed,
  refreshIsDue,
  REFRESH_AHEAD_MS,
} from './credential-refresh.js';
import type { DecryptedCredential, RefreshOutcome, SocialProvider } from './types.js';

/**
 * Renewal before use. Nothing called `refreshCredential` before this existed,
 * so the cases are the ones that decide whether a connection survives: when
 * an adapter is asked at all, what is kept when a platform does not send a
 * new refresh token, and that a failed renewal never stops the work.
 */

const NOW = new Date(Date.UTC(2026, 10, 4, 9, 0, 0));

const credential = (overrides: Partial<DecryptedCredential> = {}): DecryptedCredential => ({
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000),
  refreshableUntil: new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000),
  scopes: ['a', 'b'],
  keyVersion: 3,
  ...overrides,
});

const providerAnswering = (answer: RefreshOutcome | Error) =>
  ({
    refreshCredential: async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    },
  }) as unknown as SocialProvider;

describe('refreshIsDue', () => {
  /** Facebook Page tokens never expire, and asking would cost a debug_token call. */
  it('never offers a credential with no expiry', () => {
    expect(refreshIsDue(credential({ expiresAt: undefined }), NOW)).toBe(false);
  });

  it('offers one inside the window and leaves one beyond it', () => {
    expect(refreshIsDue(credential(), NOW)).toBe(true);
    expect(
      refreshIsDue(
        credential({ expiresAt: new Date(NOW.getTime() + REFRESH_AHEAD_MS + 60_000) }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe('attemptRefresh', () => {
  it('keeps the key version and returns what to store', async () => {
    const attempt = await attemptRefresh(
      providerAnswering({
        status: 'REFRESHED',
        credential: { accessToken: 'new-access', refreshToken: 'new-refresh', scopes: ['a', 'b'] },
      }),
      credential(),
    );

    expect(attempt.kind).toBe('REFRESHED');
    if (attempt.kind !== 'REFRESHED') return;
    expect(attempt.issued.refreshToken).toBe('new-refresh');
    expect(attempt.credential).toMatchObject({ accessToken: 'new-access', keyVersion: 3 });
  });

  /** A renewal that could not happen must not stop the publish it was in front of. */
  it('never throws, whatever the adapter does', async () => {
    const failed = await attemptRefresh(providerAnswering(new Error('down')), credential());
    expect(failed.kind).toBe('FAILED');

    const reconnect = await attemptRefresh(
      providerAnswering({ status: 'REQUIRES_RECONNECT', reason: 'gone' }),
      credential(),
    );
    expect(reconnect).toEqual({ kind: 'RECONNECT', reason: 'gone' });
  });
});

describe('mergeRefreshed', () => {
  /** Google never sends the refresh token again; dropping it would end the connection. */
  it('keeps the old refresh token and window when none came back', () => {
    const merged = mergeRefreshed(credential(), { accessToken: 'new-access', scopes: [] });
    expect(merged.refreshToken).toBe('old-refresh');
    expect(merged.refreshableUntil).toEqual(credential().refreshableUntil);
    expect(merged.scopes).toEqual(['a', 'b']);
  });

  /** X and TikTok rotate it; the old one is already spent. */
  it('takes the new refresh token when one came back', () => {
    const merged = mergeRefreshed(credential(), {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      scopes: ['a'],
    });
    expect(merged.refreshToken).toBe('new-refresh');
    expect(merged.scopes).toEqual(['a']);
  });
});
