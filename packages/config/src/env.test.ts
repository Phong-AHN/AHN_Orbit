import { describe, expect, it } from 'vitest';
import { EnvValidationError, describeEnv, parseServerEnv, workerHealthPort } from './env.js';

const key32 = Buffer.alloc(32, 7).toString('base64');

const valid = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_BUCKET: 'bucket',
  S3_ACCESS_KEY_ID: 'ak',
  S3_SECRET_ACCESS_KEY: 'sk',
  CREDENTIAL_ENCRYPTION_KEY: key32,
  STATE_SIGNING_SECRET: key32,
} satisfies NodeJS.ProcessEnv;

describe('parseServerEnv', () => {
  it('accepts a minimal valid development environment and applies defaults', () => {
    const env = parseServerEnv(valid);

    expect(env.APP_ENV).toBe('development');
    expect(env.FACEBOOK_GRAPH_VERSION).toBe('v25.0');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('reports every problem at once rather than failing on the first', () => {
    const err = (() => {
      try {
        parseServerEnv({ DATABASE_URL: 'not-a-url' });
        return undefined;
      } catch (e) {
        return e as EnvValidationError;
      }
    })();

    expect(err).toBeInstanceOf(EnvValidationError);
    expect(err!.issues.length).toBeGreaterThan(3);
    expect(err!.issues.some((i) => i.startsWith('DATABASE_URL'))).toBe(true);
    expect(err!.issues.some((i) => i.startsWith('REDIS_URL'))).toBe(true);
  });

  it('rejects an encryption key that is not exactly 32 bytes', () => {
    expect(() =>
      parseServerEnv({ ...valid, CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/32 bytes/);
  });

  it('requires provider and monitoring credentials in production', () => {
    expect(() => parseServerEnv({ ...valid, APP_ENV: 'production' })).toThrow(
      /required when APP_ENV=production/,
    );
  });

  /**
   * Server-side Firebase alone is the configuration that looks complete and is
   * not: the server would verify ID tokens the browser has no way to obtain,
   * and the only symptom is a sign-in page that does nothing (**D-050**).
   */
  it('refuses server-side Firebase without the browser config in production', () => {
    const err = (() => {
      try {
        parseServerEnv({
          ...valid,
          APP_ENV: 'production',
          APP_URL: 'https://orbit.example.com',
          FIREBASE_PROJECT_ID: 'p',
          FIREBASE_CLIENT_EMAIL: 'a@b.com',
          FIREBASE_PRIVATE_KEY: 'k',
          FACEBOOK_APP_ID: 'id',
          FACEBOOK_APP_SECRET: 'secret',
          SENTRY_DSN: 'https://sentry.example.com/1',
        });
        return undefined;
      } catch (e) {
        return e as EnvValidationError;
      }
    })();

    expect(err).toBeInstanceOf(EnvValidationError);
    expect(err!.issues).toEqual([
      'NEXT_PUBLIC_FIREBASE_API_KEY: required when APP_ENV=production',
      'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: required when APP_ENV=production',
      'NEXT_PUBLIC_FIREBASE_APP_ID: required when APP_ENV=production',
    ]);
  });

  it('refuses an S3 endpoint override in production', () => {
    expect(() =>
      parseServerEnv({
        ...valid,
        APP_ENV: 'production',
        APP_URL: 'https://orbit.example.com',
        FIREBASE_PROJECT_ID: 'p',
        FIREBASE_CLIENT_EMAIL: 'a@b.com',
        FIREBASE_PRIVATE_KEY: 'k',
        NEXT_PUBLIC_FIREBASE_API_KEY: 'web-key',
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'p.firebaseapp.com',
        NEXT_PUBLIC_FIREBASE_APP_ID: '1:1:web:1',
        FACEBOOK_APP_ID: 'id',
        FACEBOOK_APP_SECRET: 'secret',
        SENTRY_DSN: 'https://sentry.example.com/1',
        S3_ENDPOINT: 'http://localhost:9000',
      }),
    ).toThrow(/must be unset in production/);
  });

  /**
   * The paste error this exists to name: the `",` at the end comes from the
   * service-account JSON, the value stops looking quoted, the newlines are
   * never unescaped, and OpenSSL reports `DECODER routines::unsupported` from
   * somewhere deep inside firebase-admin.
   */
  it('rejects a PEM key truncated by a stray trailing character', () => {
    expect(() =>
      parseServerEnv({
        ...valid,
        FIREBASE_PRIVATE_KEY:
          '"-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n",',
      }),
    ).toThrow(/does not end with the END line/);
  });

  it('leaves a non-PEM placeholder alone', () => {
    expect(parseServerEnv({ ...valid, FIREBASE_PRIVATE_KEY: 'key' }).FIREBASE_PRIVATE_KEY).toBe(
      'key',
    );
  });

  it('unescapes newlines in the Firebase private key', () => {
    const env = parseServerEnv({ ...valid, FIREBASE_PRIVATE_KEY: 'line1\\nline2' });
    expect(env.FIREBASE_PRIVATE_KEY).toBe('line1\nline2');
  });

  it('rejects a malformed Graph API version', () => {
    expect(() => parseServerEnv({ ...valid, FACEBOOK_GRAPH_VERSION: '21' })).toThrow();
  });
});

describe('describeEnv', () => {
  it('reports presence without leaking any secret value', () => {
    const described = describeEnv(
      parseServerEnv({ ...valid, GEMINI_API_KEY: 'super-secret-value' }),
    );

    expect(described.hasGemini).toBe(true);
    expect(JSON.stringify(described)).not.toContain('super-secret-value');
    expect(JSON.stringify(described)).not.toContain(key32);
  });
});

/**
 * The worker is headless, and was being asked for the browser's Firebase keys.
 *
 * `NEXT_PUBLIC_*` is what a sign-in page needs to reach Firebase from somebody's
 * tab. The worker serves no page, verifies no ID token, and `adminAuth()` is
 * lazy so Firebase is never initialised in that process. Requiring them anyway
 * failed a Railway deploy over three variables the process cannot use — with
 * an error naming them as required, which sends somebody hunting for config a
 * worker was never going to read.
 */
describe('production requirements by process role', () => {
  const prod = {
    ...valid,
    APP_ENV: 'production',
    APP_URL: 'https://orbit.example.com',
    FIREBASE_PROJECT_ID: 'p',
    FIREBASE_CLIENT_EMAIL: 'a@b.com',
    FIREBASE_PRIVATE_KEY: 'k',
    FACEBOOK_APP_ID: 'id',
    FACEBOOK_APP_SECRET: 'secret',
    SENTRY_DSN: 'https://sentry.example.com/1',
  } satisfies NodeJS.ProcessEnv;

  it('lets the worker boot without the browser Firebase config', () => {
    expect(() => parseServerEnv({ ...prod, ORBIT_ROLE: 'worker' })).not.toThrow();
  });

  /** The web app still needs them — the exemption is the worker's alone. */
  it('still refuses the web app without them', () => {
    expect(() => parseServerEnv(prod)).toThrow(/NEXT_PUBLIC_FIREBASE_API_KEY/);
  });

  /**
   * The exemption covers exactly the browser keys. Everything else on the
   * production list applies to the worker too: it publishes with the Facebook
   * credentials, and `SENTRY_DSN` is how a failed job is seen at all.
   */
  it('still requires what the worker genuinely uses', () => {
    const { FACEBOOK_APP_SECRET: _secret, ...noFacebook } = prod;
    expect(() => parseServerEnv({ ...noFacebook, ORBIT_ROLE: 'worker' })).toThrow(
      /FACEBOOK_APP_SECRET/,
    );

    const { SENTRY_DSN: _dsn, ...noSentry } = prod;
    expect(() => parseServerEnv({ ...noSentry, ORBIT_ROLE: 'worker' })).toThrow(/SENTRY_DSN/);

    // Server-side Firebase stays required for both: it is credentials, not
    // browser config, and one process diverging on those is a sharper edge.
    const { FIREBASE_PRIVATE_KEY: _fb, ...noAdmin } = prod;
    expect(() => parseServerEnv({ ...noAdmin, ORBIT_ROLE: 'worker' })).toThrow(
      /FIREBASE_PRIVATE_KEY/,
    );
  });
});

/**
 * Railway, Heroku and Fly inject `PORT` and then probe it.
 *
 * The worker bound a hardcoded 3100 and nothing read `PORT`, so the platform's
 * health check hit a closed port and killed a container that was running
 * perfectly.
 */
describe('workerHealthPort', () => {
  it('binds the port the platform injected', () => {
    const env = parseServerEnv({ ...valid, PORT: '8080' });
    expect(workerHealthPort(env)).toBe(8080);
  });

  /** An explicit choice for this service outranks the platform's default. */
  it('prefers an explicit WORKER_HEALTH_PORT over PORT', () => {
    const env = parseServerEnv({ ...valid, PORT: '8080', WORKER_HEALTH_PORT: '3100' });
    expect(workerHealthPort(env)).toBe(3100);
  });

  it('falls back to 3100, matching the Dockerfile\u2019s EXPOSE', () => {
    expect(workerHealthPort(parseServerEnv(valid))).toBe(3100);
  });
});
