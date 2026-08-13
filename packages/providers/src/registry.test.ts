import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from '@orbit/core';
import { resetServerEnvCache } from '@orbit/config';
import {
  assertCapability,
  capabilitiesFor,
  getProvider,
  isDevelopmentOnly,
  isSupported,
  registerProvider,
  resetRegistry,
  supportedPlatforms,
} from './registry.js';
import { MockProvider } from './mock/mock-provider.js';

const key32 = Buffer.alloc(32, 5).toString('base64');

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

beforeEach(() => {
  setEnv();
  resetRegistry();
});

afterEach(() => {
  resetRegistry();
  resetServerEnvCache();
});

describe('registration', () => {
  it('registers and resolves a provider', () => {
    const provider = new MockProvider();
    registerProvider(provider);

    expect(getProvider('FACEBOOK')).toBe(provider);
    expect(isSupported('FACEBOOK')).toBe(true);
    expect(supportedPlatforms()).toEqual(['FACEBOOK']);
  });

  it('treats an unregistered platform as unsupported rather than half-working', () => {
    expect(isSupported('TIKTOK')).toBe(false);
    expect(() => getProvider('TIKTOK')).toThrow(NotFoundError);
  });

  it('explains an unsupported platform in the user’s language', () => {
    const error = (() => {
      try {
        getProvider('PINTEREST');
        return undefined;
      } catch (e) {
        return e as NotFoundError;
      }
    })();

    expect(error!.userMessage).toBe("Pinterest isn't available yet.");
    expect(error!.context.platform).toBe('PINTEREST');
  });

  it('validates the descriptor at registration, so a bad one fails at boot', () => {
    const broken = new MockProvider();
    // A descriptor that throws when built must surface here, not at publish.
    broken.capabilities = () => {
      throw new Error('malformed descriptor');
    };
    expect(() => registerProvider(broken)).toThrow(/malformed descriptor/);
  });
});

describe('development-only adapters', () => {
  it('registers in development and is flagged', () => {
    registerProvider(new MockProvider(), { developmentOnly: true });
    expect(isDevelopmentOnly('FACEBOOK')).toBe(true);
  });

  it('REFUSES to register in production', () => {
    setEnv({
      APP_ENV: 'production',
      NODE_ENV: 'production',
      APP_URL: 'https://orbit.example.com',
      FIREBASE_PROJECT_ID: 'p',
      FIREBASE_CLIENT_EMAIL: 'sa@p.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: 'k',
      NEXT_PUBLIC_FIREBASE_API_KEY: 'web-key',
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'p.firebaseapp.com',
      NEXT_PUBLIC_FIREBASE_APP_ID: '1:1:web:1',
      FACEBOOK_APP_ID: 'id',
      FACEBOOK_APP_SECRET: 'secret',
      SENTRY_DSN: 'https://sentry.example.com/1',
    });

    // The failure is at boot, not at the first publish — a mock must never be
    // reachable by real traffic (SRS §42).
    expect(() => registerProvider(new MockProvider(), { developmentOnly: true })).toThrow(
      /Refusing to register the development-only/,
    );
  });

  it('does not flag a normal adapter as development-only', () => {
    registerProvider(new MockProvider());
    expect(isDevelopmentOnly('FACEBOOK')).toBe(false);
  });
});

describe('capabilitiesFor', () => {
  it('returns the descriptor without exposing the provider', () => {
    registerProvider(new MockProvider());
    const capabilities = capabilitiesFor('FACEBOOK');
    expect(capabilities.platform).toBe('FACEBOOK');
    expect(capabilities.text.maxLength).toBeGreaterThan(0);
  });
});

describe('assertCapability', () => {
  it('passes when the capability is present', () => {
    registerProvider(new MockProvider());
    const capabilities = capabilitiesFor('FACEBOOK');
    expect(() =>
      assertCapability(capabilities, (c) => c.lifecycle.delete, 'deleting posts', 'nope'),
    ).not.toThrow();
  });

  it('throws a displayable error naming the capability', () => {
    registerProvider(new MockProvider());
    const capabilities = capabilitiesFor('FACEBOOK');

    const error = (() => {
      try {
        assertCapability(
          capabilities,
          (c) => c.webhooks.supported && false,
          'webhooks',
          'This platform cannot notify us about changes.',
        );
        return undefined;
      } catch (e) {
        return e as ValidationError;
      }
    })();

    expect(error).toBeInstanceOf(ValidationError);
    expect(error!.userMessage).toBe('This platform cannot notify us about changes.');
    expect(error!.context.capability).toBe('webhooks');
  });
});
