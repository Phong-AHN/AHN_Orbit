import { NotFoundError, clock, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { logError, logger } from '@orbit/observability';
import { CredentialCipher, attemptRefresh, refreshIsDue, tryGetProvider } from '@orbit/providers';
import type { DecryptedCredential, IssuedCredential } from '@orbit/providers';

/**
 * Opening a stored credential, in one place (SRS §6).
 *
 * The worker decrypts for two reasons now — publishing a variant and probing an
 * account's health — and the AAD binding is the kind of detail that must not be
 * retyped. Binding the ciphertext to `{ organizationId, socialAccountId }` is
 * what makes a credential row useless if it is ever moved between tenants, and a
 * second copy of this plumbing is a second chance to get that pair wrong.
 *
 * Everything here stays in memory. A decrypted token is never logged and never
 * serialised into a response; the only thing written back is a *renewed*
 * credential, sealed again before it touches the row.
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
  const aad = { organizationId: ctx.organizationId, socialAccountId };
  const row = await withTenant(ctx, (db) =>
    db.socialCredential.findFirst({ where: { socialAccountId } }),
  );

  if (!row) throw new NotFoundError('Credential');

  return freshenCredential(ctx, socialAccountId, openCredential(row, aad));
}

/**
 * The credential as it should be used now: renewed first if it is close to
 * expiry. For callers that opened the row themselves — the publish subject
 * reads it in the same transaction as the variant.
 */
export async function freshenCredential(
  ctx: TenantContext,
  socialAccountId: string,
  credential: DecryptedCredential,
): Promise<DecryptedCredential> {
  if (!refreshIsDue(credential)) return credential;
  return renewUnderLock(ctx, socialAccountId, credential);
}

/**
 * Renew a credential that is close to expiry, one renewal at a time.
 *
 * The row is locked for the length of the call. X and TikTok replace the
 * refresh token on every use, so two workers renewing the same account at once
 * would have the second present a spent token — and X ends the connection for
 * that. Under the lock the second one re-reads the row, finds the first one's
 * fresh token, and the adapter answers STILL_VALID without calling out.
 *
 * Anything short of a renewal returns the credential as it was. If it has
 * truly expired, the call that uses it fails through the normal path, which is
 * the one that records the error and decides whether to demote the account.
 */
async function renewUnderLock(
  ctx: TenantContext,
  socialAccountId: string,
  stale: DecryptedCredential,
): Promise<DecryptedCredential> {
  const aad = { organizationId: ctx.organizationId, socialAccountId };

  const account = await withTenant(ctx, (db) =>
    db.socialAccount.findFirst({ where: { id: socialAccountId }, select: { platform: true } }),
  );
  const provider = account ? tryGetProvider(account.platform) : undefined;
  if (!provider) return stale;

  try {
    return await withTenant(
      ctx,
      async (db) => {
        await db.$queryRaw`SELECT 1 FROM "SocialCredential" WHERE "socialAccountId" = ${socialAccountId}::uuid FOR UPDATE`;

        const row = await db.socialCredential.findFirst({ where: { socialAccountId } });
        if (!row) throw new NotFoundError('Credential');
        const current = openCredential(row, aad);

        const attempt = await attemptRefresh(provider, current);

        if (attempt.kind === 'REFRESHED') {
          const sealed = sealColumns(attempt.issued, aad);
          await db.socialCredential.update({ where: { id: row.id }, data: sealed });
          logger.info('credential renewed before use', {
            socialAccountId,
            organizationId: ctx.organizationId,
            platform: account?.platform,
          });
          return { ...attempt.credential, keyVersion: sealed.keyVersion };
        }

        if (attempt.kind === 'RECONNECT') {
          logger.warn('credential cannot be renewed; using it until it fails', {
            socialAccountId,
            organizationId: ctx.organizationId,
            platform: account?.platform,
            reason: attempt.reason,
          });
        } else if (attempt.kind === 'FAILED') {
          logError('credential renewal failed; using the stored one', attempt.error, {
            socialAccountId,
            organizationId: ctx.organizationId,
          });
        }

        return current;
      },
      // The renewal is a network call inside the transaction.
      { timeoutMs: 45_000 },
    );
  } catch (error) {
    // The lock or the write failed, not the platform. The stored credential
    // is still the best one available.
    logError('credential renewal could not be recorded', error, {
      socialAccountId,
      organizationId: ctx.organizationId,
    });
    return stale;
  }
}

/** A credential sealed into the row's columns, as the web app stores one. */
function sealColumns(
  issued: IssuedCredential,
  aad: { organizationId: string; socialAccountId: string },
) {
  const access = cipher.seal(issued.accessToken, aad);
  const refresh = issued.refreshToken ? cipher.seal(issued.refreshToken, aad) : undefined;
  // Prisma's Bytes wants a Uint8Array over a plain ArrayBuffer, which a Node
  // Buffer is not; `.slice()` produces exactly that.
  const bytes = (buffer: Buffer) => new Uint8Array(buffer).slice();

  return {
    accessTokenCiphertext: bytes(access.ciphertext),
    accessTokenIv: bytes(access.iv),
    accessTokenAuthTag: bytes(access.authTag),
    refreshTokenCiphertext: refresh ? bytes(refresh.ciphertext) : null,
    refreshTokenIv: refresh ? bytes(refresh.iv) : null,
    refreshTokenAuthTag: refresh ? bytes(refresh.authTag) : null,
    keyVersion: access.keyVersion,
    expiresAt: issued.expiresAt ?? null,
    refreshableUntil: issued.refreshableUntil ?? null,
    lastRefreshedAt: clock.now(),
    scopes: [...issued.scopes],
  };
}
