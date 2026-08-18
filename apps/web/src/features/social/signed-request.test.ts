import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SignedRequestInvalid, verifySignedRequest } from './signed-request';

/**
 * Meta's `signed_request`, and why the signature is not a formality.
 *
 * The deauthorize and data-deletion callbacks arrive from the internet with no
 * session and no tenant. They disconnect accounts and delete connections. The
 * signature is the **entire** authorisation, so every way of getting past it
 * without the app secret is worth an explicit test.
 */

const SECRET = 'app-secret-abc';

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function sign(payload: object, secret = SECRET): string {
  const encoded = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(encoded).digest();
  return `${b64url(signature)}.${encoded}`;
}

describe('a genuine request', () => {
  it('decodes the payload', () => {
    const parsed = verifySignedRequest(
      sign({ algorithm: 'HMAC-SHA256', user_id: 'th-user-1', issued_at: 1 }),
      SECRET,
    );

    expect(parsed.user_id).toBe('th-user-1');
  });

  /**
   * The signature covers the **encoded** segment, not the decoded JSON.
   *
   * Signing the decoded form is the classic hand-rolled mistake, and it fails
   * in a way that looks exactly like a wrong app secret — which sends somebody
   * to the developer portal instead of to this line.
   */
  it('verifies against the encoded segment, not the decoded JSON', () => {
    const payload = { user_id: 'x' };
    const encoded = b64url(JSON.stringify(payload));

    const overDecoded = createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest();

    expect(() => verifySignedRequest(`${b64url(overDecoded)}.${encoded}`, SECRET)).toThrow(
      SignedRequestInvalid,
    );
  });
});

describe('everything that must be refused', () => {
  it('refuses a payload signed with a different secret', () => {
    expect(() => verifySignedRequest(sign({ user_id: 'x' }, 'wrong-secret'), SECRET)).toThrow(
      SignedRequestInvalid,
    );
  });

  /** The whole point: an attacker cannot ask us to disconnect an account. */
  it('refuses a payload whose body was swapped after signing', () => {
    const genuine = sign({ user_id: 'attacker-account' });
    const [signature] = genuine.split('.');
    const swapped = b64url(JSON.stringify({ user_id: 'victim-account' }));

    expect(() => verifySignedRequest(`${signature}.${swapped}`, SECRET)).toThrow(
      SignedRequestInvalid,
    );
  });

  /**
   * A token naming a weaker algorithm must not talk us into using one. We only
   * ever compute HMAC-SHA256; naming anything else is rejected outright.
   */
  it('refuses a token that claims a different algorithm', () => {
    expect(() => verifySignedRequest(sign({ algorithm: 'none', user_id: 'x' }), SECRET)).toThrow(
      SignedRequestInvalid,
    );
  });

  it.each([
    ['empty', ''],
    ['no separator', 'justonesegment'],
    ['signature only', 'abc.'],
    ['payload only', '.abc'],
    [
      'payload that is not JSON',
      `${b64url(createHmac('sha256', SECRET).update(b64url('not json')).digest())}.${b64url('not json')}`,
    ],
  ])('refuses a %s request', (_label, value) => {
    expect(() => verifySignedRequest(value, SECRET)).toThrow(SignedRequestInvalid);
  });

  /**
   * `timingSafeEqual` throws on a length mismatch rather than returning false,
   * so a truncated signature would crash the route instead of being refused —
   * and a crash in a callback is a 500 that Meta retries forever.
   */
  it('refuses a truncated signature without throwing something else', () => {
    const genuine = sign({ user_id: 'x' });
    const [signature, payload] = genuine.split('.');
    const truncated = signature!.slice(0, 10);

    expect(() => verifySignedRequest(`${truncated}.${payload}`, SECRET)).toThrow(
      SignedRequestInvalid,
    );
  });
});
