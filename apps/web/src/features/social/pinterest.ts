import { NotFoundError, ValidationError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import type { DecryptedCredential } from '@orbit/providers';
import type { ResourceScope } from '@orbit/rbac';
import { tryGetProvider } from '@orbit/providers';
import { PinterestProvider } from '@orbit/providers/pinterest';
import { ensureProvidersRegistered } from '@/server/providers';
import { audit } from '@/server/audit';
import { loadCredential } from './service';

/**
 * The boards a Pinterest account can pin to (SRS §7).
 *
 * A pin has to be filed on a board and Pinterest has no default, so the
 * composer cannot offer an honest choice without asking. Read on demand rather
 * than cached: boards are created and deleted in Pinterest all the time, and a
 * cached list's failure mode is offering a board that no longer exists — which
 * surfaces as a publish failure long after the choice was made.
 *
 * A **secret** board never appears here in production. Orbit does not ask for
 * the `boards:read_secret` scope, so Pinterest does not return them, and that
 * is deliberate: a board somebody made private is not something an agency tool
 * should be quietly publishing into.
 *
 * **Sandbox mode** (`PINTEREST_SANDBOX`) is the exception, and only for test
 * data. Production boards are filtered out of the sandbox, so the boards there
 * are the secret test boards created through `createPinterestSandboxBoard`.
 */

export interface PinterestBoard {
  id: string;
  name: string;
  privacy: string;
}

/**
 * Where this account lives, for the policy engine.
 *
 * Same shape as `tiktokAccountScope`, and for the same reason: `post:create` is
 * BRAND-scoped, so a route that supplies no resource denies every Content
 * Creator whose grant is narrowed to one client. The lookup runs through the
 * tenant-scoped client, so another organization's account id is a 404 before
 * any permission is considered.
 */
export async function pinterestAccountScope({
  params,
  ctx,
}: {
  params: { accountId: string };
  ctx: TenantContext;
}): Promise<ResourceScope> {
  const account = await withTenant(ctx, (db) =>
    db.socialAccount.findFirst({
      where: { id: params.accountId, deletedAt: null },
      select: { workspaceId: true, brandId: true },
    }),
  );
  if (!account) throw new NotFoundError('Social account');

  // Spread rather than assigned: ResourceScope reads an explicit `undefined`
  // brandId as "present but unset", which is not the same as absent.
  return {
    workspaceId: account.workspaceId,
    ...(account.brandId ? { brandId: account.brandId } : {}),
  };
}

export interface PinterestBoards {
  boards: readonly PinterestBoard[];
  /** Every call goes to Pinterest's sandbox; pins made there are private. */
  sandbox: boolean;
}

/**
 * The account, its provider and its credential — or the reason there are none.
 * Shared by reading and creating boards so the two cannot drift apart on
 * which accounts qualify.
 */
async function connectedPinterest(
  ctx: TenantContext,
  socialAccountId: string,
): Promise<{
  account: { id: string; workspaceId: string; brandId: string | null };
  provider: PinterestProvider;
  credential: DecryptedCredential;
}> {
  const account = await withTenant(ctx, (db) =>
    db.socialAccount.findFirst({
      where: { id: socialAccountId, deletedAt: null },
      select: {
        id: true,
        platform: true,
        status: true,
        displayName: true,
        workspaceId: true,
        brandId: true,
      },
    }),
  );

  // Resolved through the tenant-scoped client, so an account id from another
  // organization is simply not found rather than refused.
  if (!account) throw new NotFoundError('Social account');

  if (account.platform !== 'PINTEREST') {
    throw new ValidationError('Boards are a Pinterest concept', {
      userMessage: 'This only applies to Pinterest accounts.',
    });
  }

  if (account.status !== 'ACTIVE') {
    throw new ValidationError('The account is not connected', {
      userMessage: `${account.displayName} needs to be reconnected before its boards can be read.`,
    });
  }

  // The registry is per process: a cold instance has nothing in it until
  // somebody fills it, and without this the platform reads as unconfigured.
  ensureProvidersRegistered();
  const provider = tryGetProvider('PINTEREST');
  if (!(provider instanceof PinterestProvider)) {
    throw new ValidationError('Pinterest is not configured', {
      userMessage: 'Pinterest is not available on this deployment.',
    });
  }

  const credential = await loadCredential(ctx, socialAccountId);
  return { account, provider, credential };
}

export async function fetchPinterestBoards(
  ctx: TenantContext,
  socialAccountId: string,
): Promise<PinterestBoards> {
  const { provider, credential } = await connectedPinterest(ctx, socialAccountId);

  // Deliberately id, name and privacy only. Pinterest also returns pin counts,
  // owner and cover images; none of it is needed to pick a board, and each
  // extra field is another thing leaving the server for no reason.
  return { boards: await provider.listBoards(credential), sandbox: provider.sandbox };
}

/**
 * Create a secret board in Pinterest's sandbox, so a test account has
 * somewhere to pin. Refused outside sandbox mode, before Pinterest is called:
 * Orbit never creates boards on a client's real account.
 */
export async function createPinterestSandboxBoard(
  ctx: TenantContext,
  socialAccountId: string,
  name: string,
): Promise<PinterestBoard> {
  const { account, provider, credential } = await connectedPinterest(ctx, socialAccountId);

  if (!provider.sandbox) {
    throw new ValidationError('Boards are created only in Pinterest sandbox mode', {
      userMessage: 'Create the board in Pinterest, then reopen this post.',
    });
  }

  const board = await provider.createSandboxBoard(credential, name);

  await withTenant(ctx, (db) =>
    audit(db, ctx, {
      action: 'social_account.pinterest_board_created',
      resourceType: 'SocialAccount',
      resourceId: account.id,
      workspaceId: account.workspaceId,
      ...(account.brandId ? { brandId: account.brandId } : {}),
      after: { boardId: board.id, privacy: board.privacy, sandbox: true },
    }),
  );

  return board;
}
