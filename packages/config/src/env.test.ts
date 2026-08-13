import { describe, expect, it } from 'vitest';
import { EnvValidationError, describeEnv, parseServerEnv } from './env.js';

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
    expect(env.FACEBOOK_GRAPH_VERSION).toBe('v21.0');
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

  it('refuses an S3 endpoint override in production', () => {
    expect(() =>
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
        S3_ENDPOINT: 'http://localhost:9000',
      }),
    ).toThrow(/must be unset in production/);
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
