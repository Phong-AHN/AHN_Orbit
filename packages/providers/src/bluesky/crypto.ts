import {
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';

/**
 * The cryptography atproto OAuth needs, on `node:crypto` alone.
 *
 * Three things, all ES256 (P-256 / SHA-256), all signed in the JOSE `r||s`
 * form (`ieee-p1363`) rather than DER, which is what a JWT verifier expects:
 *
 *   • the **client assertion** that authenticates Social Square at the token
 *     endpoint (`private_key_jwt`), signed with the app's long-lived key;
 *   • a **DPoP proof** for every request, signed with the session's own key,
 *     binding each access token to that key;
 *   • the **session key** itself, derived rather than generated, so the start
 *     of a connect flow and its callback produce the same key without either
 *     storing it.
 */

export interface PrivateEcJwk {
  kty: 'EC';
  crv: 'P-256';
  d: string;
  x: string;
  y: string;
  kid?: string | undefined;
}

export interface PublicEcJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid?: string | undefined;
}

export interface Es256Key {
  privateKey: KeyObject;
  privateJwk: PrivateEcJwk;
  publicJwk: PublicEcJwk;
}

/** The order of the P-256 group: a private scalar must be in [1, n). */
const P256_ORDER = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');

export function keyFromPrivateJwk(jwk: PrivateEcJwk): Es256Key {
  const privateKey = createPrivateKey({ key: { ...jwk }, format: 'jwk' });
  const exported = createPublicKey(privateKey).export({ format: 'jwk' }) as {
    x?: string;
    y?: string;
  };
  if (!exported.x || !exported.y) throw new Error('Not a P-256 key');

  const publicJwk: PublicEcJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: exported.x,
    y: exported.y,
    ...(jwk.kid ? { kid: jwk.kid } : {}),
  };
  return {
    privateKey,
    privateJwk: {
      kty: 'EC',
      crv: 'P-256',
      d: jwk.d,
      x: exported.x,
      y: exported.y,
      ...(jwk.kid ? { kid: jwk.kid } : {}),
    },
    publicJwk,
  };
}

/**
 * A P-256 key derived from a secret and a label.
 *
 * HMAC-SHA256 gives 32 bytes; read as a number, they are a valid private
 * scalar unless they fall outside [1, n), which happens about once in 2^32
 * tries — then the counter moves on. Same secret and label, same key.
 */
export function deriveEs256Key(secret: Uint8Array, label: string): Es256Key {
  for (let counter = 0; counter < 16; counter += 1) {
    const seed = createHmac('sha256', secret).update(`${label}:${counter}`).digest();
    const scalar = BigInt(`0x${seed.toString('hex')}`);
    if (scalar === 0n || scalar >= P256_ORDER) continue;

    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(seed);
    // Uncompressed point: 0x04 || X (32 bytes) || Y (32 bytes).
    const point = ecdh.getPublicKey();
    return keyFromPrivateJwk({
      kty: 'EC',
      crv: 'P-256',
      d: seed.toString('base64url'),
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
    });
  }
  throw new Error('Could not derive a P-256 key');
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject,
): string {
  const input = `${encode(header)}.${encode(payload)}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${signature.toString('base64url')}`;
}

/**
 * A DPoP proof (RFC 9449) for one request.
 *
 * `htu` is the URL without query or fragment, as the RFC requires; `ath` binds
 * the proof to the access token when one is sent; `nonce` is whatever the
 * server last handed out, which atproto servers require.
 */
export function dpopProof(input: {
  key: Es256Key;
  method: string;
  url: string;
  nowMs: number;
  nonce?: string | undefined;
  accessToken?: string | undefined;
}): string {
  const target = new URL(input.url);
  const htu = `${target.origin}${target.pathname}`;
  const { kid: _kid, ...jwk } = input.key.publicJwk;

  return signJwt(
    { typ: 'dpop+jwt', alg: 'ES256', jwk },
    {
      jti: randomUUID(),
      htm: input.method.toUpperCase(),
      htu,
      iat: Math.floor(input.nowMs / 1000),
      ...(input.nonce ? { nonce: input.nonce } : {}),
      ...(input.accessToken
        ? { ath: createHash('sha256').update(input.accessToken).digest('base64url') }
        : {}),
    },
    input.key.privateKey,
  );
}

/**
 * The `private_key_jwt` client assertion (RFC 7523): Social Square proving it
 * is itself to the authorization server, whose issuer is the audience.
 */
export function clientAssertion(input: {
  key: Es256Key;
  clientId: string;
  audience: string;
  nowMs: number;
}): string {
  const iat = Math.floor(input.nowMs / 1000);
  return signJwt(
    { alg: 'ES256', ...(input.key.publicJwk.kid ? { kid: input.key.publicJwk.kid } : {}) },
    {
      iss: input.clientId,
      sub: input.clientId,
      aud: input.audience,
      jti: randomUUID(),
      iat,
      exp: iat + 60,
    },
    input.key.privateKey,
  );
}

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Read `BLUESKY_PRIVATE_KEY`: a one-line ES256 private JWK with a `kid`.
 *
 * Throws on anything else, naming what is wrong and never the value — the
 * deployment set it and meant something by it, and silently not offering
 * Bluesky would leave them guessing why.
 */
export function parsePrivateJwk(raw: string): PrivateEcJwk {
  let parsed: Partial<PrivateEcJwk>;
  try {
    parsed = JSON.parse(raw) as Partial<PrivateEcJwk>;
  } catch {
    throw new Error('BLUESKY_PRIVATE_KEY is not JSON; it should be a one-line JWK');
  }
  if (parsed.kty !== 'EC' || parsed.crv !== 'P-256' || !parsed.d || !parsed.x || !parsed.y) {
    throw new Error('BLUESKY_PRIVATE_KEY must be an EC P-256 private JWK (kty, crv, d, x, y)');
  }
  if (!parsed.kid) throw new Error('BLUESKY_PRIVATE_KEY needs a kid, which the JWKS publishes');
  // Proves the parts belong together before anything is signed with them.
  keyFromPrivateJwk(parsed as PrivateEcJwk);
  return parsed as PrivateEcJwk;
}
