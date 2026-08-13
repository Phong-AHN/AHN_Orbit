import {
  ConflictError,
  NotFoundError,
  PlanLimitExceededError,
  accountStatusForErrorCode,
  clock,
  isAppError,
  isProbeDue,
  type Platform,
  type TenantContext,
} from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import {
  CredentialCipher,
  getProvider,
  type AccountHealth,
  type DecryptedCredential,
  type DiscoveredAccount,
  type IssuedCredential,
} from '@orbit/providers';
import { audit, type AuditInput } from '@/server/audit';
import { applyHealthVerdict } from './health';
import { issueOAuthState } from './oauth-state';

/**
 * Social account connection (T1.6).
 *
 * Platform-agnostic by construction: everything here goes through
 * `getProvider(platform)`, and there is no Meta-specific branch. Adding
 * Instagram means registering an adapter, not editing this file.
 */

const cipher = new CredentialCipher();

/** Fields safe to return to any caller. Never includes credential material. */
const ACCOUNT_SELECT = {
  id: true,
  platform: true,
  externalId: true,
  handle: true,
  displayName: true,
  avatarUrl: true,
  accountType: true,
  status: true,
  healthCheckedAt: true,
  healthError: true,
  scopes: true,
  brandId: true,
  workspaceId: true,
  connectedAt: true,
} as const;

async function seatLimit(db: TenantDb): Promise<number | undefined> {
  const subscription = await db.subscription.findFirst({ select: { limits: true } });
  const limits = subscription?.limits as { socialAccounts?: number } | undefined;
  return limits?.socialAccounts;
}

/** Persist a credential, sealed. Called for both connect and reconnect. */
async function storeCredential(
  db: TenantDb,
  organizationId: string,
  socialAccountId: string,
  issued: IssuedCredential,
): Promise<void> {
  const aad = { organizationId, socialAccountId };
  const access = cipher.seal(issued.accessToken, aad);
  const refresh = issued.refreshToken ? cipher.seal(issued.refreshToken, aad) : undefined;

  // Prisma's `Bytes` is `ReturnType<Uint8Array['slice']>` — a Uint8Array backed
  // by a plain ArrayBuffer. Node's Buffer is generic over ArrayBufferLike and
  // is not assignable to it, so `.slice()` produces exactly the right type.
  const bytes = (buffer: Buffer) => new Uint8Array(buffer).slice();

  // The relation scalars are set only on create: with a composite foreign key
  // they identify the row, so restating them in an update is not permitted.
  const data = {
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

  const existing = await db.socialCredential.findFirst({
    where: { socialAccountId },
    select: { id: true },
  });

  if (existing) {
    await db.socialCredential.update({ where: { id: existing.id }, data });
  } else {
    await db.socialCredential.create({ data: { ...data, organizationId, socialAccountId } });
  }
}

/**
 * Load and decrypt a credential.
 *
 * The only place ciphertext becomes a token, and it happens inside the server
 * process, in memory. Nothing here is ever returned to a caller (SRS §6).
 */
export async function loadCredential(
  ctx: TenantContext,
  socialAccountId: string,
): Promise<DecryptedCredential> {
  return withTenant(ctx, async (db) => {
    const row = await db.socialCredential.findFirst({
      where: { socialAccountId },
    });
    if (!row) throw new NotFoundError('Credential');

    const aad = { organizationId: ctx.organizationId, socialAccountId };

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
  });
}

// ── Listing ─────────────────────────────────────────────────────────────────

export async function listAccounts(
  ctx: TenantContext,
  filter: { workspaceId?: string; brandId?: string } = {},
) {
  return withTenant(ctx, (db) =>
    db.socialAccount.findMany({
      where: {
        deletedAt: null,
        ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
        ...(filter.brandId ? { brandId: filter.brandId } : {}),
      },
      select: ACCOUNT_SELECT,
      orderBy: { displayName: 'asc' },
    }),
  );
}

/**
 * Accounts that cannot publish until someone reconnects them (T1.7).
 *
 * Narrow on purpose — it feeds a banner, so it selects the three fields the
 * banner shows and nothing else. `REVOKED` and `DISABLED` are excluded: neither
 * is a breakage, they are states a person put the account into, and prompting
 * someone to "reconnect" an account they deliberately disconnected would be
 * reporting their own action back to them as a fault.
 */
export async function listAccountsNeedingReconnection(
  ctx: TenantContext,
  filter: { workspaceId?: string } = {},
) {
  return withTenant(ctx, (db) =>
    db.socialAccount.findMany({
      where: {
        deletedAt: null,
        status: 'NEEDS_RECONNECT',
        ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
      },
      select: { id: true, displayName: true, healthError: true },
      orderBy: { displayName: 'asc' },
    }),
  );
}

export async function getAccount(ctx: TenantContext, socialAccountId: string) {
  return withTenant(ctx, async (db) => {
    const account = await db.socialAccount.findFirst({
      where: { id: socialAccountId, deletedAt: null },
      select: ACCOUNT_SELECT,
    });
    if (!account) throw new NotFoundError('Social account');
    return account;
  });
}

// ── Staging (the OAuth handoff) ─────────────────────────────────────────────

/**
 * Persist everything OAuth discovered, as DISABLED rows.
 *
 * The user picks which Pages to connect *after* the exchange, so the
 * credentials have to survive between the callback and that choice. The
 * options were a cookie (tokens in the browser, and a 4KB ceiling a user with
 * many Pages would breach) or a server-side store. Until Redis lands (T1.11)
 * this is the store: rows written encrypted-at-rest, then either activated or
 * deleted within minutes.
 *
 * A DISABLED account publishes nothing and appears nowhere — `listAccounts`
 * filters to ACTIVE for the picker's siblings, and the composer only offers
 * ACTIVE accounts.
 */
export async function stageDiscoveredAccounts(
  ctx: TenantContext,
  input: {
    platform: Platform;
    workspaceId: string;
    brandId: string;
    discovered: readonly DiscoveredAccount[];
  },
): Promise<Array<{ id: string; externalId: string; alreadyConnected: boolean }>> {
  return withTenant(ctx, async (db) => {
    const brand = await db.brand.findFirst({
      where: { id: input.brandId, workspaceId: input.workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new NotFoundError('Brand');

    const staged = [];

    for (const account of input.discovered) {
      const existing = await db.socialAccount.findFirst({
        where: { platform: input.platform, externalId: account.externalId },
        select: { id: true, status: true, deletedAt: true },
      });

      const alreadyConnected = Boolean(
        existing && existing.deletedAt === null && existing.status !== 'DISABLED',
      );

      const data = {
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        displayName: account.displayName,
        handle: account.handle ?? null,
        avatarUrl: account.avatarUrl ?? null,
        accountType: account.accountType ?? null,
        scopes: [...account.credential.scopes],
      };

      let id: string;
      if (existing) {
        id = existing.id;
        await db.socialAccount.update({
          where: { id },
          data: {
            ...data,
            // An account already live stays live; only fresh ones are staged.
            ...(alreadyConnected ? {} : { status: 'DISABLED', deletedAt: null }),
          },
        });
      } else {
        const created = await db.socialAccount.create({
          data: {
            organizationId: ctx.organizationId,
            platform: input.platform,
            externalId: account.externalId,
            status: 'DISABLED',
            connectedById: ctx.principal.kind === 'USER' ? ctx.principal.userId : null,
            ...data,
          },
          select: { id: true },
        });
        id = created.id;
      }

      // Sealed immediately: a staged credential is encrypted at rest from the
      // moment it exists, exactly like a connected one.
      await storeCredential(db, ctx.organizationId, id, account.credential);

      staged.push({ id, externalId: account.externalId, alreadyConnected });
    }

    return staged;
  });
}

/** Discard staged rows the user did not choose, credentials included. */
export async function discardStagedAccounts(
  ctx: TenantContext,
  input: { platform: Platform; keepIds: readonly string[] },
): Promise<number> {
  return withTenant(ctx, async (db) => {
    const stale = await db.socialAccount.findMany({
      where: {
        platform: input.platform,
        status: 'DISABLED',
        ...(input.keepIds.length > 0 ? { id: { notIn: [...input.keepIds] } } : {}),
      },
      select: { id: true },
    });

    if (stale.length === 0) return 0;

    const ids = stale.map((s) => s.id);
    await db.socialCredential.deleteMany({ where: { socialAccountId: { in: ids } } });
    await db.socialAccount.deleteMany({ where: { id: { in: ids } } });

    logger.info('discarded unselected staged accounts', {
      platform: input.platform,
      count: ids.length,
    });

    return ids.length;
  });
}

// ── Connect ─────────────────────────────────────────────────────────────────

export interface ConnectInput {
  platform: Platform;
  workspaceId: string;
  brandId: string;
  /** Ids of staged accounts the user chose. */
  socialAccountIds: readonly string[];
}

/**
 * Connect the accounts a user selected after OAuth.
 *
 * Reconnecting an account that already exists updates its credential and
 * clears the unhealthy flag rather than creating a duplicate — which is what
 * makes the reconnect flow the same code path as the connect flow.
 */
export async function connectAccounts(
  ctx: TenantContext,
  input: ConnectInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  // Resolving the provider here means an unregistered platform fails before we
  // touch the database, with the registry's "not available yet" message.
  getProvider(input.platform);

  const results = await withTenant(ctx, async (db) => {
    // Every id must be a staged row in *this* tenant. Scoped, so an id from
    // another organization is simply not found.
    const staged = await db.socialAccount.findMany({
      where: { id: { in: [...input.socialAccountIds] }, platform: input.platform },
      select: { id: true, externalId: true, displayName: true, status: true, scopes: true },
    });

    if (staged.length !== input.socialAccountIds.length) {
      throw new NotFoundError('Account', {
        userMessage: 'One of the selected accounts is no longer available. Please try again.',
      });
    }

    const limit = await seatLimit(db);
    if (limit !== undefined) {
      const live = await db.socialAccount.count({
        where: { deletedAt: null, status: { not: 'DISABLED' } },
      });
      const adding = staged.filter((s) => s.status === 'DISABLED').length;
      if (live + adding > limit) {
        throw new PlanLimitExceededError('Social account limit reached', {
          userMessage: `Your plan includes ${limit} connected accounts. Upgrade to connect more.`,
          context: { limit, live, adding },
        });
      }
    }

    const connected = [];

    for (const account of staged) {
      const reconnected = account.status !== 'DISABLED';

      await db.socialAccount.update({
        where: { id: account.id },
        data: {
          status: 'ACTIVE',
          healthError: null,
          healthCheckedAt: clock.now(),
          connectedAt: clock.now(),
          deletedAt: null,
        },
      });

      await audit(db, ctx, {
        action: reconnected ? 'social_account.reconnected' : 'social_account.connected',
        resourceType: 'SocialAccount',
        resourceId: account.id,
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        // The token is deliberately absent — only its presence is recorded.
        after: {
          platform: input.platform,
          externalId: account.externalId,
          displayName: account.displayName,
          scopes: account.scopes,
        },
        ...fingerprint,
      });

      connected.push({ id: account.id, externalId: account.externalId, reconnected });
    }

    return connected;
  });

  // Anything staged but not chosen is discarded, credentials and all.
  await discardStagedAccounts(ctx, {
    platform: input.platform,
    keepIds: input.socialAccountIds,
  });

  logger.info('social accounts connected', {
    platform: input.platform,
    count: results.length,
    brandId: input.brandId,
  });

  return results;
}

// ── Health ──────────────────────────────────────────────────────────────────

/**
 * Probe an account and record the verdict.
 *
 * Health is **probe-driven, not expiry-driven** (docs/SOCIAL_PROVIDERS.md §4): a
 * Page token generally carries no expiry and yet stops working the moment the
 * granting user changes their password or loses access to the Page. There is
 * nothing to check but the platform itself.
 *
 * Two behaviours are load-bearing here:
 *
 *  • **A transient outage propagates rather than demoting the account.** Only an
 *    error that actually means "this credential is no longer good" becomes a
 *    verdict — `accountStatusForErrorCode` decides which — because marking every
 *    account `NEEDS_RECONNECT` during a five-minute Meta outage would send a
 *    reconnect prompt to every client for no reason.
 *  • **The verdict, its audit row and its notifications commit together**, so an
 *    account is never silently broken.
 *
 * `minIntervalMs` exists for the debounce the worker's sweep applies. A person
 * asking for a check gets one: the default is 0, because "check now" that
 * quietly does nothing is worse than a spent provider call.
 */
export async function checkAccountHealth(
  ctx: TenantContext,
  socialAccountId: string,
  options: { minIntervalMs?: number } = {},
): Promise<AccountHealth> {
  const account = await getAccount(ctx, socialAccountId);

  if (!isProbeDue(account.healthCheckedAt, clock.now(), options.minIntervalMs ?? 0)) {
    // Recent enough to stand. Returning the stored verdict keeps the response
    // shape identical whether or not a call was actually made.
    return {
      status: account.status,
      grantedScopes: account.scopes,
      missingScopes: [],
      message: account.healthError ?? undefined,
      checkedAt: account.healthCheckedAt ?? clock.now(),
    };
  }

  const credential = await loadCredential(ctx, socialAccountId);
  const provider = getProvider(account.platform);

  let health: AccountHealth;

  try {
    health = await provider.probeHealth(credential, { externalId: account.externalId });
  } catch (error) {
    const code = isAppError(error) ? error.code : null;
    const demotedTo = code ? accountStatusForErrorCode(code) : null;

    // Says nothing about the account — a timeout, a 500, a network blip. Let it
    // surface as the error it is rather than blaming the connection.
    if (!demotedTo) throw error;

    health = {
      status: demotedTo,
      grantedScopes: account.scopes,
      missingScopes: [],
      message: isAppError(error) ? error.userMessage : 'The connection is no longer valid.',
      checkedAt: clock.now(),
    };
  }

  await withTenant(ctx, (db) =>
    applyHealthVerdict(
      db,
      ctx,
      {
        id: account.id,
        status: account.status,
        displayName: account.displayName,
        workspaceId: account.workspaceId,
        brandId: account.brandId,
      },
      {
        status: health.status,
        message: health.message ?? null,
        grantedScopes: health.grantedScopes,
        checkedAt: health.checkedAt,
      },
    ),
  );

  return health;
}

// ── Reconnect ───────────────────────────────────────────────────────────────

export interface ReconnectStart {
  authorizationUrl: string;
  scopes: readonly string[];
  /** Mirrored into the HttpOnly cookie by the route. */
  nonce: string;
}

/**
 * Begin reconnecting an existing account (T1.7).
 *
 * Everything that identifies the connection — platform, workspace, brand — is
 * read from the **account row**, never from the request. A caller supplies one
 * id and nothing else, so there is no field through which a reconnect could be
 * pointed at another workspace's brand, and a cross-tenant id is simply not
 * found.
 *
 * It reuses the T1.6 state issuer unchanged: signed, session-bound, single-use
 * and expiring. Reconnecting is the same OAuth flow as connecting, and the
 * callback that finishes it cannot tell the two apart — which is the point.
 * `connectAccounts` already recognises an existing row and updates it rather
 * than creating a duplicate.
 */
export async function startReconnect(
  ctx: TenantContext,
  input: { socialAccountId: string; userId: string; redirectUri: string; returnTo?: string },
): Promise<ReconnectStart> {
  const account = await getAccount(ctx, input.socialAccountId);

  // A revoked account has had its credential deleted and its row soft-deleted;
  // there is nothing to reconnect, and the honest answer is to connect afresh.
  if (account.status === 'REVOKED') {
    throw new ConflictError('Account was disconnected', {
      userMessage: 'This account was disconnected. Connect it again from scratch.',
      context: { socialAccountId: input.socialAccountId },
    });
  }

  const provider = getProvider(account.platform);

  const { state, nonce } = issueOAuthState({
    platform: account.platform,
    organizationId: ctx.organizationId,
    workspaceId: account.workspaceId,
    brandId: account.brandId,
    userId: input.userId,
    ...(input.returnTo !== undefined ? { returnTo: input.returnTo } : {}),
  });

  const { url, scopes } = provider.getAuthorizationUrl({ redirectUri: input.redirectUri, state });

  logger.info('reconnect started', {
    socialAccountId: account.id,
    platform: account.platform,
    organizationId: ctx.organizationId,
  });

  return { authorizationUrl: url, scopes, nonce };
}

// ── Disconnect ──────────────────────────────────────────────────────────────

export async function disconnectAccount(
  ctx: TenantContext,
  socialAccountId: string,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const account = await getAccount(ctx, socialAccountId);

  // Best effort at the provider; local disconnection must succeed regardless,
  // or a revoked account could never be cleaned up.
  try {
    const credential = await loadCredential(ctx, socialAccountId);
    await getProvider(account.platform).revoke(credential, {
      externalId: account.externalId,
    });
  } catch (error) {
    logger.warn('provider revocation failed; disconnecting locally anyway', {
      socialAccountId,
      platform: account.platform,
      reason: (error as { code?: string }).code ?? 'unknown',
    });
  }

  await withTenant(ctx, async (db) => {
    const scheduled = await db.postVariant.count({
      where: { socialAccountId, status: 'SCHEDULED', deletedAt: null },
    });

    if (scheduled > 0) {
      throw new ConflictError('Account still has scheduled posts', {
        userMessage: `This account has ${scheduled} scheduled post${
          scheduled === 1 ? '' : 's'
        }. Cancel or reschedule them before disconnecting.`,
        context: { socialAccountId, scheduled },
      });
    }

    // The credential row goes; the account is soft-deleted so published history
    // and analytics keep their reference.
    await db.socialCredential.deleteMany({ where: { socialAccountId } });
    await db.socialAccount.update({
      where: { id: socialAccountId },
      data: { status: 'REVOKED', deletedAt: clock.now() },
    });

    await audit(db, ctx, {
      action: 'social_account.disconnected',
      resourceType: 'SocialAccount',
      resourceId: socialAccountId,
      workspaceId: account.workspaceId,
      brandId: account.brandId,
      before: { platform: account.platform, displayName: account.displayName },
      ...fingerprint,
    });
  });
}
