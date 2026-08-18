import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta's `signed_request`, verified rather than trusted (SRS §6, §31).
 *
 * Meta POSTs this to the deauthorize and data-deletion callbacks. Both act on
 * somebody's account without any session — nobody is logged in, and the request
 * arrives from the internet — so the signature is the *only* thing separating a
 * genuine notice from an attacker asking us to disconnect an account or delete
 * a tenant's data.
 *
 * It is a two-part token, `signature.payload`, both base64url. The signature is
 * HMAC-SHA256 of the raw payload segment keyed by the app secret — over the
 * **encoded** segment, not the decoded JSON, which is the detail that makes a
 * hand-rolled implementation fail for reasons nobody can see.
 */

export interface SignedRequestPayload {
  algorithm?: string;
  issued_at?: number;
  expires?: number;
  /** The app-scoped user id, which is what an account's `externalId` holds. */
  user_id?: string;
}

export class SignedRequestInvalid extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'SignedRequestInvalid';
  }
}

function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verify and decode, or throw.
 *
 * Throwing rather than returning `undefined` is deliberate: every caller here
 * acts on somebody's data, and a signature check whose failure can be ignored
 * by forgetting an `if` is not a security control.
 */
export function verifySignedRequest(
  signedRequest: string,
  appSecret: string,
): SignedRequestPayload {
  const [signature, payload] = signedRequest.split('.');

  if (!signature || !payload) {
    throw new SignedRequestInvalid('Malformed signed_request: expected signature.payload');
  }

  const expected = createHmac('sha256', appSecret)
    // The *encoded* segment is what is signed. Signing the decoded JSON
    // produces a mismatch that looks like a wrong secret.
    .update(payload)
    .digest();

  const received = base64UrlDecode(signature);

  // Constant-time, and length-checked first because `timingSafeEqual` throws on
  // a length mismatch rather than returning false.
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new SignedRequestInvalid('Signature does not match');
  }

  let parsed: SignedRequestPayload;
  try {
    parsed = JSON.parse(base64UrlDecode(payload).toString('utf8')) as SignedRequestPayload;
  } catch {
    throw new SignedRequestInvalid('Payload is not JSON');
  }

  if (parsed.algorithm && parsed.algorithm.toUpperCase() !== 'HMAC-SHA256') {
    // An attacker naming a weaker algorithm must not be able to talk us into
    // using it. We only ever compute HMAC-SHA256; this rejects the claim.
    throw new SignedRequestInvalid(`Unexpected algorithm: ${parsed.algorithm}`);
  }

  return parsed;
}
