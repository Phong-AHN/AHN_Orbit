import { describe, expect, it } from 'vitest';
import { CredentialCipher, safeEquals } from './credential-cipher.js';

const KEY_V1 = Buffer.alloc(32, 1);
const KEY_V2 = Buffer.alloc(32, 2);

const resolver = (version: number) => (version === 1 ? KEY_V1 : version === 2 ? KEY_V2 : undefined);

const aad = { organizationId: 'org-a', socialAccountId: 'acct-1' };

describe('CredentialCipher', () => {
  const cipher = new CredentialCipher(resolver, 1);

  it('round-trips a token', () => {
    const sealed = cipher.seal('EAAG-super-secret-token', aad);
    expect(cipher.open(sealed, aad)).toBe('EAAG-super-secret-token');
  });

  it('never stores the plaintext in the ciphertext', () => {
    const sealed = cipher.seal('EAAG-super-secret-token', aad);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('EAAG');
    expect(sealed.ciphertext.toString('base64')).not.toContain('EAAG');
  });

  it('produces a different ciphertext each time, so equal tokens are not linkable', () => {
    const a = cipher.seal('same-token', aad);
    const b = cipher.seal('same-token', aad);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const sealed = cipher.seal('token', aad);
    sealed.ciphertext[0] ^= 0xff;
    expect(() => cipher.open(sealed, aad)).toThrow(/could not be decrypted/);
  });

  it('refuses a tampered auth tag', () => {
    const sealed = cipher.seal('token', aad);
    sealed.authTag[0] ^= 0xff;
    expect(() => cipher.open(sealed, aad)).toThrow(/could not be decrypted/);
  });

  it('refuses a credential moved to another account', () => {
    // The AAD binds ciphertext to one organization and account, so a row copied
    // between tenants fails to authenticate.
    const sealed = cipher.seal('token', aad);
    expect(() =>
      cipher.open(sealed, { organizationId: 'org-b', socialAccountId: 'acct-1' }),
    ).toThrow(/could not be decrypted/);
    expect(() =>
      cipher.open(sealed, { organizationId: 'org-a', socialAccountId: 'acct-2' }),
    ).toThrow(/could not be decrypted/);
  });

  it('records the key version it sealed under', () => {
    expect(cipher.seal('token', aad).keyVersion).toBe(1);
  });

  it('decrypts a value sealed under an older key', () => {
    const old = new CredentialCipher(resolver, 1).seal('legacy-token', aad);
    const current = new CredentialCipher(resolver, 2);

    expect(current.open(old, aad)).toBe('legacy-token');
    expect(current.needsRotation(old)).toBe(true);
  });

  it('does not flag a current-version value for rotation', () => {
    const current = new CredentialCipher(resolver, 2);
    expect(current.needsRotation(current.seal('token', aad))).toBe(false);
  });

  it('fails clearly when the key version is unknown', () => {
    const sealed = cipher.seal('token', aad);
    const orphaned = { ...sealed, keyVersion: 99 };
    expect(() => cipher.open(orphaned, aad)).toThrow(/No encryption key/);
  });

  it('never puts the ciphertext or key into the user-facing message', () => {
    const sealed = cipher.seal('token', aad);
    sealed.authTag[0] ^= 0xff;

    try {
      cipher.open(sealed, aad);
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as { userMessage?: string }).userMessage ?? '';
      expect(message).not.toContain('token');
      expect(message).not.toContain(sealed.ciphertext.toString('base64'));
    }
  });
});

describe('safeEquals', () => {
  it('matches identical strings', () => {
    expect(safeEquals('abc', 'abc')).toBe(true);
  });

  it('rejects different strings and different lengths', () => {
    expect(safeEquals('abc', 'abd')).toBe(false);
    expect(safeEquals('abc', 'abcd')).toBe(false);
  });
});
