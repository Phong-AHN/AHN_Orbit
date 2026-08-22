import { NotFoundError, ValidationError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import type { ResourceScope } from '@orbit/rbac';
import { tryGetProvider } from '@orbit/providers';
import { PinterestProvider } from '@orbit/providers/pinterest';
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
 * A **secret** board never appears here. Orbit does not ask for the
 * `boards:read_secret` scope, so Pinterest does not return them, and that is
 * deliberate: a board somebody made private is not something an agency tool
 * should be quietly publishing into.
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

export async function fetchPinterestBoards(
  ctx: TenantContext,
  socialAccountId: string,
): Promise<readonly PinterestBoard[]> {
  const account = await withTenant(ctx, (db) =>
    db.socialAccount.findFirst({
      where: { id: socialAccountId, deletedAt: null },
      select: { id: true, platform: true, status: true, displayName: true },
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

  const provider = tryGetProvider('PINTEREST');
  if (!(provider instanceof PinterestProvider)) {
    throw new ValidationError('Pinterest is not configured', {
      userMessage: 'Pinterest is not available on this deployment.',
    });
  }

  const credential = await loadCredential(ctx, socialAccountId);

  // Deliberately id, name and privacy only. Pinterest also returns pin counts,
  // owner and cover images; none of it is needed to pick a board, and each
  // extra field is another thing leaving the server for no reason.
  return provider.listBoards(credential);
}
