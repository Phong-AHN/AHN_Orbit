import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@orbit/config';
import { InternalError } from '@orbit/core';

/**
 * Credential encryption at rest (SRS §6).
 *
 * AES-256-GCM, which authenticates as well as encrypts — a tampered ciphertext
 * fails to decrypt rather than yielding plausible garbage that gets sent to a
 * provider as a token.
 *
 * `keyVersion` is stored beside every credential so keys can be rotated without
 * a migration: new writes use the current key, old rows decrypt with the key
 * they were sealed under until a background re-encrypt catches up.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the GCM standard
const KEY_BYTES = 32;

export interface SealedValue {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

/** Additional authenticated data: binds a credential to its account. */
export interface CredentialAad {
  organizationId: string;
  socialAccountId: string;
}

/**
 * Key resolution.
 *
 * In production these come from KMS/Secrets Manager. The interface accepts a
 * resolver so rotation is a configuration change rather than a code change.
 */
export type KeyResolver = (version: number) => Buffer | undefined;

function defaultKeyResolver(version: number): Buffer | undefined {
  const env = serverEnv();
  if (version !== env.CREDENTIAL_ENCRYPTION_KEY_VERSION) return undefined;

  const key = Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new InternalError('Credential encryption key is not 32 bytes');
  }
  return key;
}

export class CredentialCipher {
  constructor(
    private readonly resolveKey: KeyResolver = defaultKeyResolver,
    private readonly currentVersion: number = serverEnv().CREDENTIAL_ENCRYPTION_KEY_VERSION,
  ) {}

  /**
   * Encrypt a token.
   *
   * The AAD binds the ciphertext to one organization and account, so a
   * credential row copied to another tenant's account fails authentication
   * instead of decrypting — the composite foreign keys stop that at the schema
   * level too, but defence in depth is cheap here.
   */
  seal(plaintext: string, aad: CredentialAad): SealedValue {
    const key = this.resolveKey(this.currentVersion);
    if (!key) throw new InternalError('No encryption key for the current version');

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(aadString(aad), 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: this.currentVersion };
  }

  open(sealed: SealedValue, aad: CredentialAad): string {
    const key = this.resolveKey(sealed.keyVersion);
    if (!key) {
      throw new InternalError('No encryption key for the stored key version', {
        context: { keyVersion: sealed.keyVersion },
      });
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
      decipher.setAAD(Buffer.from(aadString(aad), 'utf8'));
      decipher.setAuthTag(sealed.authTag);
      return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
      // Never echo the ciphertext or the key version into a user-facing path.
      throw new InternalError('Stored credential could not be decrypted', { cause: error });
    }
  }

  /** Whether a sealed value was written under an older key and wants re-sealing. */
  needsRotation(sealed: SealedValue): boolean {
    return sealed.keyVersion !== this.currentVersion;
  }
}

function aadString(aad: CredentialAad): string {
  return `${aad.organizationId}:${aad.socialAccountId}`;
}

/** Constant-time comparison, for webhook signatures and similar. */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
