import { NotFoundError, clock, type Platform, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { logError, logger } from '@orbit/observability';
import {
  CredentialCipher,
  asDueForRenewal,
  attemptRefresh,
  refreshIsDue,
  settleRenewal,
  tryGetProvider,
} from '@orbit/providers';
import type { DecryptedCredential, IssuedCredential, RefreshAttempt } from '@orbit/providers';

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
 * What comes back is decided by `settleRenewal`: never a credential that has
 * already expired, because using one only produces a 401 that reads as a dead
 * connection (D-114).
 */
async function renewUnderLock(
  ctx: TenantContext,
  socialAccountId: string,
  stale: DecryptedCredential,
): Promise<DecryptedCredential> {
  const platform = await platformOf(ctx, socialAccountId);
  if (!platform) return stale;

  let renewal: Renewal | null;
  try {
    renewal = await renewInTransaction(ctx, socialAccountId, platform, { force: false });
  } catch (error) {
    // The lock or the write failed, not the platform. Nothing is known about
    // the account; the stored credential is used if it still works.
    logError('credential renewal could not be recorded', error, {
      socialAccountId,
      organizationId: ctx.organizationId,
    });
    return settleRenewal(platform, stale, { kind: 'FAILED', error });
  }

  if (!renewal) return stale;
  return settleRenewal(platform, renewal.current, renewal.attempt);
}

/**
 * Renew now, whatever the stored expiry says.
 *
 * For a probe whose token the platform has just refused: a token withdrawn
 * early is not a dead connection while the refresh token still works, and
 * asking costs one call where a wrong verdict costs somebody a reconnection.
 *
 * Returns the renewed credential, or null when there was nothing to renew with
 * (no refresh token, or no adapter here). Throws an authentication error when
 * the platform refused the refresh token, and an unavailable one when it could
 * not be asked — the same rule as every other renewal.
 */
export async function renewNow(
  ctx: TenantContext,
  socialAccountId: string,
): Promise<DecryptedCredential | null> {
  const platform = await platformOf(ctx, socialAccountId);
  if (!platform) return null;

  const renewal = await renewInTransaction(ctx, socialAccountId, platform, { force: true });
  if (!renewal || renewal.attempt.kind === 'UNCHANGED') return null;

  return settleRenewal(platform, { ...renewal.current, expiresAt: new Date(0) }, renewal.attempt);
}

interface Renewal {
  current: DecryptedCredential;
  attempt: RefreshAttempt;
}

async function platformOf(ctx: TenantContext, socialAccountId: string): Promise<Platform | null> {
  const account = await withTenant(ctx, (db) =>
    db.socialAccount.findFirst({ where: { id: socialAccountId }, select: { platform: true } }),
  );
  return account && tryGetProvider(account.platform) ? account.platform : null;
}

/**
 * The renewal itself: lock the row, re-read it, ask the adapter, store what
 * comes back. Null when there is no adapter for the platform in this process.
 */
async function renewInTransaction(
  ctx: TenantContext,
  socialAccountId: string,
  platform: Platform,
  options: { force: boolean },
): Promise<Renewal | null> {
  const aad = { organizationId: ctx.organizationId, socialAccountId };
  const provider = tryGetProvider(platform);
  if (!provider) return null;

  return withTenant(
    ctx,
    async (db) => {
      await db.$queryRaw`SELECT 1 FROM "SocialCredential" WHERE "socialAccountId" = ${socialAccountId}::uuid FOR UPDATE`;

      const row = await db.socialCredential.findFirst({ where: { socialAccountId } });
      if (!row) throw new NotFoundError('Credential');
      const current = openCredential(row, aad);

      const offered = options.force ? asDueForRenewal(current) : current;
      if (!offered) return { current, attempt: { kind: 'UNCHANGED' } };

      const attempt = await attemptRefresh(provider, offered);

      if (attempt.kind === 'REFRESHED') {
        const sealed = sealColumns(attempt.issued, aad);
        await db.socialCredential.update({ where: { id: row.id }, data: sealed });
        logger.info('credential renewed before use', {
          socialAccountId,
          organizationId: ctx.organizationId,
          platform,
          forced: options.force,
        });
        return {
          current,
          attempt: {
            ...attempt,
            credential: { ...attempt.credential, keyVersion: sealed.keyVersion },
          },
        };
      }

      if (attempt.kind === 'RECONNECT') {
        logger.warn('the platform refused to renew a credential', {
          socialAccountId,
          organizationId: ctx.organizationId,
          platform,
          reason: attempt.reason,
        });
      } else if (attempt.kind === 'FAILED') {
        logError('credential renewal failed', attempt.error, {
          socialAccountId,
          organizationId: ctx.organizationId,
          platform,
        });
      }

      return { current, attempt };
    },
    // The renewal is a network call inside the transaction, and must finish
    // well inside this: a renewal the platform accepted but this transaction
    // then rolled back has spent a rotating refresh token for nothing.
    { timeoutMs: 45_000 },
  );
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
