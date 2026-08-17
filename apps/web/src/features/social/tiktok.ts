import { NotFoundError, ValidationError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import type { ResourceScope } from '@orbit/rbac';
import { tryGetProvider } from '@orbit/providers';
import { TikTokProvider } from '@orbit/providers/tiktok';
import { loadCredential } from './service';

/**
 * What a TikTok creator currently allows (SRS §7).
 *
 * TikTok requires that a direct post carry a `privacy_level` chosen from the
 * options `creator_info/query` returns for that account **at that moment**, and
 * treats ignoring them as a Terms of Service violation rather than a bad
 * request. So this is not a convenience endpoint — the composer cannot honestly
 * offer a choice without it, and a stored choice can go stale when a creator
 * switches their account to private.
 *
 * It is read on demand rather than cached. A cache would be a copy of somebody
 * else's settings that is right most of the time, and the failure mode of "most
 * of the time" here is posting under a visibility the creator did not pick.
 */

export interface CreatorOptions {
  username: string;
  nickname: string;
  privacyLevels: readonly string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoSeconds: number;
}

/**
 * Where this account lives, for the policy engine.
 *
 * `post:create` is BRAND-scoped, so a route that supplies no resource denies
 * every Content Creator whose grant is narrowed to one client — the account is
 * *inside* a workspace and a brand, and the policy engine needs to be told
 * which. The lookup runs through the tenant-scoped client, so another
 * organization's account id is a 404 before any permission is considered.
 */
export async function tiktokAccountScope({
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

export async function fetchTikTokCreatorOptions(
  ctx: TenantContext,
  socialAccountId: string,
): Promise<CreatorOptions> {
  const account = await withTenant(ctx, (db) =>
    db.socialAccount.findFirst({
      where: { id: socialAccountId, deletedAt: null },
      select: { id: true, platform: true, status: true, displayName: true },
    }),
  );

  // Resolved through the tenant-scoped client, so an account id from another
  // organization is simply not found rather than refused.
  if (!account) throw new NotFoundError('Social account');

  if (account.platform !== 'TIKTOK') {
    throw new ValidationError('Creator options are a TikTok concept', {
      userMessage: 'This only applies to TikTok accounts.',
    });
  }

  if (account.status !== 'ACTIVE') {
    throw new ValidationError('The account is not connected', {
      userMessage: `${account.displayName} needs to be reconnected before its posting options can be read.`,
    });
  }

  const provider = tryGetProvider('TIKTOK');
  if (!(provider instanceof TikTokProvider)) {
    throw new ValidationError('TikTok is not configured', {
      userMessage: 'TikTok is not available on this deployment.',
    });
  }

  const credential = await loadCredential(ctx, socialAccountId);
  const info = await provider.fetchCreatorInfo(credential);

  return {
    username: info.creatorUsername,
    nickname: info.creatorNickname,
    privacyLevels: info.privacyLevelOptions,
    commentDisabled: info.commentDisabled,
    duetDisabled: info.duetDisabled,
    stitchDisabled: info.stitchDisabled,
    maxVideoSeconds: info.maxVideoPostDurationSec,
    // Deliberately absent: `creatorAvatarUrl`. It is a TikTok CDN URL for an
    // account the agency may not own, and nothing in the composer needs it.
  };
}
