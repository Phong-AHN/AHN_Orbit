import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitiveKey, redact, redactUrl } from './redact.js';

describe('isSensitiveKey', () => {
  it.each([
    'accessToken',
    'access_token',
    'refreshToken',
    'FACEBOOK_APP_SECRET',
    'client_secret',
    'password',
    'Authorization',
    'x-hub-signature-256',
    'accessTokenCiphertext',
    'apiKey',
    'CREDENTIAL_ENCRYPTION_KEY',
    'Set-Cookie',
  ])('flags %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['keyVersion', 'correlationId', 'inputTokens', 'signatureValid', 'email', 'status'])(
    'allows %s through',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe('redact', () => {
  it('strips secrets at any depth', () => {
    const input = {
      user: { email: 'a@b.test' },
      provider: {
        response: { data: { access_token: 'EAAG...', expires_in: 5183944 } },
      },
    };

    const out = redact(input) as typeof input;

    expect(out.user.email).toBe('a@b.test');
    expect(out.provider.response.data.access_token).toBe(REDACTED);
    expect(out.provider.response.data.expires_in).toBe(5183944);
  });

  it('strips secrets inside arrays', () => {
    const out = redact([{ token: 'x' }, { safe: 'y' }]) as Array<Record<string, unknown>>;
    expect(out[0]!.token).toBe(REDACTED);
    expect(out[1]!.safe).toBe('y');
  });

  it('does not mutate the input', () => {
    const input = { token: 'keep-me-in-the-original' };
    redact(input);
    expect(input.token).toBe('keep-me-in-the-original');
  });

  it('summarises buffers rather than dumping ciphertext', () => {
    const out = redact({ blob: Buffer.alloc(64) }) as { blob: string };
    expect(out.blob).toBe('[buffer 64b]');
  });

  it('survives a circular structure instead of hanging', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
    expect((redact(a) as Record<string, unknown>).self).toBe('[circular]');
  });

  it('keeps error name, message and stack while redacting attached fields', () => {
    const err = Object.assign(new Error('boom'), { accessToken: 'secret' });
    const out = redact({ err }) as { err: Record<string, unknown> };
    expect(out.err.message).toBe('boom');
    expect(out.err.accessToken).toBe(REDACTED);
  });

  it('truncates beyond a bounded depth', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(JSON.stringify(redact(deep))).toContain('[truncated]');
  });

  it('passes primitives through untouched', () => {
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
  });
});

describe('redactUrl', () => {
  it('redacts an OAuth authorization code and state', () => {
    const out = redactUrl('https://app.test/callback?code=abc123&state=xyz&brandId=b1');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('xyz');
    expect(out).toContain('brandId=b1');
  });

  it('redacts presigned S3 signature parameters', () => {
    const out = redactUrl('https://s3.test/o?X-Amz-Signature=deadbeef&X-Amz-Expires=900');
    expect(out).not.toContain('deadbeef');
  });

  it('redacts credentials embedded in the authority', () => {
    const out = redactUrl('postgresql://user:hunter2@localhost:5432/orbit');
    expect(out).not.toContain('hunter2');
  });

  it('returns a non-URL string unchanged rather than throwing', () => {
    expect(redactUrl('not a url')).toBe('not a url');
  });
});
