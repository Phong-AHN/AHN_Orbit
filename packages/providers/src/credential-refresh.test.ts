import { describe, expect, it } from 'vitest';
import { ProviderUnavailableError, isClientStandingFailure } from '@orbit/core';
import {
  asDueForRenewal,
  attemptRefresh,
  isExpired,
  mergeRefreshed,
  refreshIsDue,
  settleRenewal,
  REFRESH_AHEAD_MS,
  type RefreshAttempt,
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

/**
 * What a caller gets after a renewal (D-114). An expired credential is never
 * handed out: using one only produces a 401, which read as a dead connection
 * and demoted accounts whose only problem was a renewal that blinked.
 */
describe('settleRenewal', () => {
  const expired = credential({ expiresAt: new Date(NOW.getTime() - 60_000) });
  const valid = credential({ expiresAt: new Date(NOW.getTime() + 60 * 60 * 1000) });
  const transient: RefreshAttempt = { kind: 'FAILED', error: new Error('socket hang up') };

  it('hands over a renewed credential', () => {
    const renewed = credential({ accessToken: 'new-access' });
    const attempt: RefreshAttempt = {
      kind: 'REFRESHED',
      issued: { accessToken: 'new-access', scopes: ['a'] },
      credential: renewed,
    };
    expect(settleRenewal('X', expired, attempt, NOW)).toBe(renewed);
  });

  it('keeps a credential that still works, whatever the renewal said', () => {
    expect(settleRenewal('X', valid, transient, NOW)).toBe(valid);
    expect(settleRenewal('X', valid, { kind: 'RECONNECT', reason: 'no' }, NOW)).toBe(valid);
    expect(settleRenewal('X', expired, { kind: 'UNCHANGED' }, NOW)).toBe(expired);
  });

  /** The flapping case: a blip at the token endpoint is not a dead connection. */
  it('never uses an expired credential when the renewal merely failed', () => {
    let thrown: unknown;
    try {
      settleRenewal('X', expired, transient, NOW);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderUnavailableError);
    expect((thrown as ProviderUnavailableError).retryable).toBe(true);
    expect((thrown as ProviderUnavailableError).context['credentialRenewal']).toBe('FAILED');
    expect(isClientStandingFailure(thrown)).toBe(false);
  });

  it('says plainly when the platform refused the refresh token', () => {
    expect(() =>
      settleRenewal(
        'X',
        expired,
        { kind: 'RECONNECT', reason: 'X rejected the refresh token.' },
        NOW,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'PROVIDER_AUTHENTICATION_ERROR',
        userMessage: 'X rejected the refresh token.',
      }),
    );
  });

  /** A wrong client secret is an administrator's problem, not the account's. */
  it('passes a refusal of our own app through untouched', () => {
    const appRefused = new ProviderUnavailableError('X OAuth refused: unauthorized_client', {
      context: { clientStanding: true },
    });

    expect(() => settleRenewal('X', expired, { kind: 'FAILED', error: appRefused }, NOW)).toThrow(
      appRefused,
    );
  });

  it('treats a token with seconds left as expired', () => {
    const almost = credential({ expiresAt: new Date(NOW.getTime() + 30_000) });
    expect(isExpired(almost, NOW)).toBe(true);
    expect(() => settleRenewal('X', almost, transient, NOW)).toThrow(ProviderUnavailableError);
  });

  it('never calls a credential with no expiry expired', () => {
    expect(isExpired(credential({ expiresAt: undefined }), NOW)).toBe(false);
  });
});

describe('asDueForRenewal', () => {
  it('presents the credential as expired, so the adapter renews it now', () => {
    expect(asDueForRenewal(credential())?.expiresAt?.getTime()).toBe(0);
  });

  /** Meta renews with the access token itself, which cannot renew a dead one. */
  it('declines a credential with no refresh token', () => {
    expect(asDueForRenewal(credential({ refreshToken: undefined }))).toBeNull();
  });
});
