import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnauthenticatedError, fixedClock, setClock } from '@orbit/core';
import { resetServerEnvCache } from '@orbit/config';
import { devIdentityProvider, resetDevSessions, assertDevelopmentOnly } from './dev-provider.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  clearedSessionCookie,
  requireSession,
  selectIdentityProvider,
  sessionCookie,
} from './session.js';

const key32 = Buffer.alloc(32, 3).toString('base64');

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
    CREDENTIAL_ENCRYPTION_KEY: key32,
    STATE_SIGNING_SECRET: key32,
    // Cleared explicitly: the root .env is loaded into process.env for local
    // development, and its local-storage endpoint would otherwise leak in.
    S3_ENDPOINT: undefined,
    FIREBASE_PROJECT_ID: undefined,
    FIREBASE_CLIENT_EMAIL: undefined,
    FIREBASE_PRIVATE_KEY: undefined,
    ...overrides,
  };

  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetServerEnvCache();
}

/**
 * A complete, valid production configuration.
 *
 * Note that "production without Firebase" is not expressible: env validation
 * makes the Firebase credentials mandatory when APP_ENV=production, which is
 * the outermost of the three guards. These tests therefore prove the strongest
 * available statement — that even in a *fully valid* production environment,
 * the development provider still refuses to run.
 */
function setProductionEnv(overrides: Record<string, string | undefined> = {}) {
  setEnv({
    APP_ENV: 'production',
    NODE_ENV: 'production',
    APP_URL: 'https://orbit.example.com',
    FIREBASE_PROJECT_ID: 'orbit-prod',
    FIREBASE_CLIENT_EMAIL: 'sa@orbit-prod.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: 'key',
    FACEBOOK_APP_ID: 'id',
    FACEBOOK_APP_SECRET: 'secret',
    SENTRY_DSN: 'https://sentry.example.com/1',
    ...overrides,
  });
}

let restoreClock: (() => void) | undefined;

beforeEach(() => {
  setEnv();
  resetDevSessions();
  restoreClock = setClock(fixedClock(new Date('2026-08-11T12:00:00Z')));
});

afterEach(() => {
  restoreClock?.();
  resetServerEnvCache();
});

describe('cookie attributes', () => {
  it('is HttpOnly, SameSite=Lax and path-wide', () => {
    const cookie = sessionCookie('value');
    expect(cookie.name).toBe(SESSION_COOKIE_NAME);
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('lax');
    expect(cookie.path).toBe('/');
    expect(cookie.maxAge).toBe(SESSION_MAX_AGE_MS / 1000);
  });

  it('is not Secure on local http, and Secure everywhere else', () => {
    expect(sessionCookie('v').secure).toBe(false);

    setEnv({ APP_URL: 'https://orbit.example.com' });
    expect(sessionCookie('v').secure).toBe(true);
  });

  it('clears with an empty value and a zero max-age', () => {
    const cleared = clearedSessionCookie();
    expect(cleared.value).toBe('');
    expect(cleared.maxAge).toBe(0);
    expect(cleared.httpOnly).toBe(true);
  });
});

describe('identity provider selection', () => {
  it('uses Firebase whenever it is configured', () => {
    setEnv({
      FIREBASE_PROJECT_ID: 'p',
      FIREBASE_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: 'key',
    });
    expect(selectIdentityProvider().kind).toBe('firebase');
  });

  it('falls back to the development provider only in development', () => {
    expect(selectIdentityProvider().kind).toBe('development');
  });

  it('selects Firebase — never the dev provider — in a valid production config', () => {
    setProductionEnv();
    expect(selectIdentityProvider().kind).toBe('firebase');
  });

  it('refuses to fall back when only NODE_ENV says production', () => {
    setEnv({ NODE_ENV: 'production' });
    expect(() => selectIdentityProvider()).toThrow(/not permitted in production/);
  });
});

describe('development provider guards', () => {
  it('throws from assertDevelopmentOnly in production', () => {
    setProductionEnv();
    expect(() => assertDevelopmentOnly()).toThrow(/never be used in production/);
  });

  it('refuses to mint a cookie in production even if called directly', async () => {
    setProductionEnv();
    await expect(devIdentityProvider.createSessionCookie('dev:a@b.test', 1000)).rejects.toThrow(
      /never be used in production/,
    );
  });

  it('refuses to verify a cookie in production even if one is presented', async () => {
    const cookie = await devIdentityProvider.createSessionCookie('dev:a@b.test', 60_000);
    setProductionEnv();
    await expect(devIdentityProvider.verifySessionCookie(cookie)).rejects.toThrow(
      /never be used in production/,
    );
  });

  it('is additionally blocked by env validation, which requires Firebase in production', () => {
    setEnv({ APP_ENV: 'production', APP_URL: 'https://orbit.example.com' });
    expect(() => selectIdentityProvider()).toThrow(/FIREBASE_PROJECT_ID: required/);
  });
});

describe('session round trip', () => {
  it('mints a cookie that verifies back to the same identity', async () => {
    const cookie = await devIdentityProvider.createSessionCookie('dev:owner@ahn.test', 60_000);
    const identity = await devIdentityProvider.verifySessionCookie(cookie);

    expect(identity.uid).toBe('dev:owner@ahn.test');
    expect(identity.email).toBe('owner@ahn.test');
  });

  it('lowercases the email so identity lookups cannot be case-split', async () => {
    const identity = await devIdentityProvider.verifyIdToken('dev:Owner@AHN.test');
    expect(identity.email).toBe('owner@ahn.test');
    expect(identity.uid).toBe('dev:owner@ahn.test');
  });

  it('rejects a tampered payload', async () => {
    const cookie = await devIdentityProvider.createSessionCookie('dev:a@b.test', 60_000);
    const [, signature] = cookie.split('.');

    const forged = Buffer.from(
      JSON.stringify({
        uid: 'dev:admin@orbit.test',
        email: 'admin@orbit.test',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      }),
      'utf8',
    ).toString('base64url');

    await expect(devIdentityProvider.verifySessionCookie(`${forged}.${signature}`)).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('rejects a cookie signed with a different secret', async () => {
    const cookie = await devIdentityProvider.createSessionCookie('dev:a@b.test', 60_000);
    setEnv({ STATE_SIGNING_SECRET: Buffer.alloc(32, 9).toString('base64') });
    await expect(devIdentityProvider.verifySessionCookie(cookie)).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('rejects a malformed cookie', async () => {
    for (const bad of ['', 'no-dot', 'a.b.c.d', '.sig']) {
      await expect(devIdentityProvider.verifySessionCookie(bad)).rejects.toThrow(
        UnauthenticatedError,
      );
    }
  });

  it('rejects an expired cookie', async () => {
    const clock = fixedClock(new Date('2026-08-11T12:00:00Z'));
    restoreClock?.();
    restoreClock = setClock(clock);

    const cookie = await devIdentityProvider.createSessionCookie('dev:a@b.test', 60_000);
    clock.advance(60_001);

    await expect(devIdentityProvider.verifySessionCookie(cookie)).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('rejects a cookie taken before sign-out — revocation is immediate', async () => {
    const clock = fixedClock(new Date('2026-08-11T12:00:00Z'));
    restoreClock?.();
    restoreClock = setClock(clock);

    const cookie = await devIdentityProvider.createSessionCookie('dev:a@b.test', 3_600_000);
    expect(await devIdentityProvider.verifySessionCookie(cookie)).toBeTruthy();

    clock.advance(1000);
    await devIdentityProvider.revokeSessions('dev:a@b.test');

    await expect(devIdentityProvider.verifySessionCookie(cookie)).rejects.toThrow(
      UnauthenticatedError,
    );
  });

  it('rejects an id token that is not a usable email', async () => {
    for (const bad of ['dev:', 'dev:notanemail', 'nope@b.test', 'dev:a@b']) {
      await expect(devIdentityProvider.verifyIdToken(bad)).rejects.toThrow(UnauthenticatedError);
    }
  });
});

describe('requireSession', () => {
  it('throws when no cookie is present', async () => {
    await expect(requireSession(undefined)).rejects.toThrow(UnauthenticatedError);
  });

  it('never leaks the rejection reason to the caller', async () => {
    const error = await requireSession('garbage').catch((e: UnauthenticatedError) => e);
    expect(error).toBeInstanceOf(UnauthenticatedError);
    expect((error as UnauthenticatedError).userMessage).toBe('Please sign in to continue.');
    // The diagnostic detail exists, but only in the logged context.
    expect((error as UnauthenticatedError).context.reason).toBeTruthy();
  });
});
