import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnauthenticatedError, ValidationError, fixedClock, setClock } from '@orbit/core';
import { resetServerEnvCache } from '@orbit/config';
import { issueOAuthState, verifyOAuthState } from './oauth-state';

/**
 * The CSRF properties of the connect flow.
 *
 * The threat: an attacker completes *their* Facebook consent inside *your*
 * session, so their Page lands in your organization. Signature, session
 * binding, single use and expiry each block a different route to that.
 */

const key32 = Buffer.alloc(32, 11).toString('base64');

function setEnv(overrides: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    APP_ENV: 'development',
    NODE_ENV: 'development',
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    REDIS_URL: 'redis://localhost:6379',
    S3_BUCKET: 'b',
    S3_ACCESS_KEY_ID: 'a',
    S3_SECRET_ACCESS_KEY: 's',
    S3_ENDPOINT: undefined,
    CREDENTIAL_ENCRYPTION_KEY: key32,
    STATE_SIGNING_SECRET: key32,
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetServerEnvCache();
}

const seed = {
  platform: 'FACEBOOK' as const,
  organizationId: '018f0000-0000-7000-8000-00000000000a',
  workspaceId: '018f0000-0000-7000-8000-00000000000b',
  brandId: '018f0000-0000-7000-8000-00000000000c',
  userId: '018f0000-0000-7000-8000-00000000000d',
};

let restoreClock: (() => void) | undefined;

beforeEach(() => {
  setEnv();
  restoreClock = setClock(fixedClock(new Date('2026-08-12T12:00:00Z')));
});

afterEach(() => {
  restoreClock?.();
  resetServerEnvCache();
});

describe('round trip', () => {
  it('verifies a state it issued', () => {
    const { state, cookie } = issueOAuthState(seed);
    const payload = verifyOAuthState({ state, cookie, sessionUserId: seed.userId });

    expect(payload.organizationId).toBe(seed.organizationId);
    expect(payload.brandId).toBe(seed.brandId);
  });

  it('carries the return path through the flow', () => {
    const { state, cookie } = issueOAuthState({ ...seed, returnTo: '/acme/settings/accounts' });
    const payload = verifyOAuthState({ state, cookie, sessionUserId: seed.userId });
    expect(payload.returnTo).toBe('/acme/settings/accounts');
  });
});

describe('what the platform carries', () => {
  /**
   * X caps `state` at 500 characters and refused every connection while the
   * signed payload rode in it. The state is the nonce alone now.
   */
  it('keeps the state short however long the payload is', () => {
    const { state } = issueOAuthState({
      ...seed,
      returnTo: `/orgs/a-long-agency-name/settings/accounts/connect?workspaceId=${seed.workspaceId}&brandId=${seed.brandId}&platform=X`,
    });
    expect(state.length).toBeLessThanOrEqual(64);
  });

  /** Organization and workspace ids stay out of another company's URLs and logs. */
  it('puts no internal id in the state', () => {
    const { state } = issueOAuthState(seed);
    for (const id of Object.values(seed)) expect(state).not.toContain(id);
  });
});

describe('forgery', () => {
  it('rejects a tampered payload', () => {
    const { state } = issueOAuthState(seed);
    const forged = Buffer.from(
      JSON.stringify({ ...seed, nonce: state, expiresAt: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url');

    expect(() =>
      verifyOAuthState({
        state,
        cookie: `${forged}.not-a-real-signature`,
        sessionUserId: seed.userId,
      }),
    ).toThrow(ValidationError);
  });

  it('rejects a payload signed with a different secret', () => {
    const { state, cookie } = issueOAuthState(seed);
    setEnv({ STATE_SIGNING_SECRET: Buffer.alloc(32, 99).toString('base64') });

    expect(() => verifyOAuthState({ state, cookie, sessionUserId: seed.userId })).toThrow(
      ValidationError,
    );
  });

  it.each(['', 'no-dot', '.sig', 'a.b.c'])('rejects a malformed cookie %j', (cookie) => {
    expect(() => verifyOAuthState({ state: 'n', cookie, sessionUserId: seed.userId })).toThrow(
      ValidationError,
    );
  });
});

describe('session binding', () => {
  it('REJECTS a state issued to a different user', () => {
    // The core CSRF defence: an attacker's state cannot be completed inside
    // someone else's session.
    const { state, cookie } = issueOAuthState(seed);

    expect(() =>
      verifyOAuthState({
        state,
        cookie,
        sessionUserId: '018f0000-0000-7000-8000-00000000ffff',
      }),
    ).toThrow(UnauthenticatedError);
  });
});

describe('single use', () => {
  it('rejects a state that does not match the payload in the cookie', () => {
    const { cookie } = issueOAuthState(seed);

    // Somebody else's state, or a replay against a newer flow's cookie.
    expect(() =>
      verifyOAuthState({ state: 'a-different-nonce', cookie, sessionUserId: seed.userId }),
    ).toThrow(ValidationError);
  });

  it('rejects a state with no cookie at all', () => {
    // Replay after the cookie was cleared on first callback.
    const { state } = issueOAuthState(seed);
    expect(() =>
      verifyOAuthState({ state, cookie: undefined, sessionUserId: seed.userId }),
    ).toThrow(ValidationError);
  });

  it('issues a distinct nonce every time', () => {
    const a = issueOAuthState(seed);
    const b = issueOAuthState(seed);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.state).not.toBe(b.state);
    expect(a.cookie).not.toBe(b.cookie);
  });
});

describe('expiry', () => {
  it('rejects a state older than ten minutes', () => {
    const clock = fixedClock(new Date('2026-08-12T12:00:00Z'));
    restoreClock?.();
    restoreClock = setClock(clock);

    const { state, cookie } = issueOAuthState(seed);
    clock.advance(10 * 60 * 1000 + 1);

    expect(() => verifyOAuthState({ state, cookie, sessionUserId: seed.userId })).toThrow(
      ValidationError,
    );
  });

  it('accepts one just inside the window', () => {
    const clock = fixedClock(new Date('2026-08-12T12:00:00Z'));
    restoreClock?.();
    restoreClock = setClock(clock);

    const { state, cookie } = issueOAuthState(seed);
    clock.advance(9 * 60 * 1000);

    expect(() => verifyOAuthState({ state, cookie, sessionUserId: seed.userId })).not.toThrow();
  });
});

describe('organization binding', () => {
  it('rejects a state for a different organization than the callback expects', () => {
    const { state, cookie } = issueOAuthState(seed);

    expect(() =>
      verifyOAuthState({
        state,
        cookie,
        sessionUserId: seed.userId,
        expectedOrganizationId: '018f0000-0000-7000-8000-00000000eeee',
      }),
    ).toThrow(ValidationError);
  });
});

describe('error messages', () => {
  it('never reveals which check failed', () => {
    const { state, cookie } = issueOAuthState(seed);

    const messages = [
      capture(() => verifyOAuthState({ state, cookie: 'bad.sig', sessionUserId: seed.userId })),
      capture(() => verifyOAuthState({ state: 'wrong', cookie, sessionUserId: seed.userId })),
      capture(() => verifyOAuthState({ state: undefined, cookie, sessionUserId: seed.userId })),
    ];

    // One message for every failure mode: a probe learns nothing.
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe('That connection link is no longer valid. Please start again.');
  });

  it('records the specific reason in the log context', () => {
    const error = capture(
      () => verifyOAuthState({ state: 'n', cookie: 'bad.sig', sessionUserId: seed.userId }),
      true,
    ) as unknown as ValidationError;

    expect(error.context.securityEvent).toBe(true);
    expect(error.context.reason).toBeTruthy();
  });
});

function capture(fn: () => unknown, raw = false): string {
  try {
    fn();
    throw new Error('expected a rejection');
  } catch (error) {
    if (raw) return error as unknown as string;
    return (error as ValidationError).userMessage;
  }
}
