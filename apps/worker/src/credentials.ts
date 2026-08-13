import { NotFoundError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { CredentialCipher } from '@orbit/providers';
import type { DecryptedCredential } from '@orbit/providers';

/**
 * Opening a stored credential, in one place (SRS §6).
 *
 * The worker decrypts for two reasons now — publishing a variant and probing an
 * account's health — and the AAD binding is the kind of detail that must not be
 * retyped. Binding the ciphertext to `{ organizationId, socialAccountId }` is
 * what makes a credential row useless if it is ever moved between tenants, and a
 * second copy of this plumbing is a second chance to get that pair wrong.
 *
 * Everything here stays in memory. A decrypted token is never logged, never
 * serialised into a response, and never written back to the database.
 */

/** One cipher for the process. Key material is resolved per call, not held. */
const cipher = new CredentialCipher();

/** The shape stored in `SocialCredential`, as Prisma returns it. */
export interface StoredCredential {
  accessTokenCiphertext: Uint8Array;
  accessTokenIv: Uint8Array;
  accessTokenAuthTag: Uint8Array;
  refreshTokenCiphertext: Uint8Array | null;
  refreshTokenIv: Uint8Array | null;
  refreshTokenAuthTag: Uint8Array | null;
  keyVersion: number;
  expiresAt: Date | null;
  refreshableUntil: Date | null;
  scopes: string[];
}

export function openCredential(
  row: StoredCredential,
  aad: { organizationId: string; socialAccountId: string },
): DecryptedCredential {
  return {
    accessToken: cipher.open(
      {
        ciphertext: Buffer.from(row.accessTokenCiphertext),
        iv: Buffer.from(row.accessTokenIv),
        authTag: Buffer.from(row.accessTokenAuthTag),
        keyVersion: row.keyVersion,
      },
      aad,
    ),
    ...(row.refreshTokenCiphertext && row.refreshTokenIv && row.refreshTokenAuthTag
      ? {
          refreshToken: cipher.open(
            {
              ciphertext: Buffer.from(row.refreshTokenCiphertext),
              iv: Buffer.from(row.refreshTokenIv),
              authTag: Buffer.from(row.refreshTokenAuthTag),
              keyVersion: row.keyVersion,
            },
            aad,
          ),
        }
      : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt } : {}),
    ...(row.refreshableUntil ? { refreshableUntil: row.refreshableUntil } : {}),
    scopes: row.scopes,
    keyVersion: row.keyVersion,
  };
}

/**
 * Load and decrypt the credential for one account.
 *
 * Scoped, so an account id belonging to another tenant simply is not found —
 * the AAD would refuse to open it even if the row were somehow reachable.
 */
export async function loadAccountCredential(
  ctx: TenantContext,
  socialAccountId: string,
): Promise<DecryptedCredential> {
  const row = await withTenant(ctx, (db) =>
    db.socialCredential.findFirst({ where: { socialAccountId } }),
  );

  if (!row) throw new NotFoundError('Credential');

  return openCredential(row, { organizationId: ctx.organizationId, socialAccountId });
}
