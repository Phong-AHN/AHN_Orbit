import { accessibleWorkspaceIds, RateLimitedError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { enqueue, takeToken } from '@orbit/queue';
import { assertCan, canSomewhere } from '@orbit/rbac';
import { logger } from '@orbit/observability';
import { capabilitiesFor } from '@orbit/providers';
import { ensureProvidersRegistered } from '@/server/providers';

/**
 * Read Page and post figures now, instead of on the worker's cadence (D-122).
 *
 * **This queues; it never calls a provider.** The web app produces and only
 * the worker consumes (D-022), and analytics are never read on a page load
 * (D-058) because Meta's per-app rate limit is the same quota publishing
 * spends. A press is the same jobs the sweep would queue, sooner — so it is
 * bounded the way the inbox's "Check now" is (D-104): one press per
 * organization per five minutes, at most 50 accounts and the 50 most recent
 * published posts in scope, and only what the caller can see.
 *
 * Gated on `report:generate`: refreshing spends the tenant's provider quota,
 * and it is the people who report results to a client who need the figures
 * fresh. The narrowing below still applies to them.
 */

const COOLDOWN_MS = 5 * 60 * 1_000;
const MAX_ACCOUNTS = 50;
const MAX_POSTS = 50;
/** Posts older than this are past the cadence that keeps refreshing them. */
const POST_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1_000;

export interface RefreshScope {
  workspaceId?: string;
  socialAccountId?: string;
}

export async function refreshAnalyticsNow(
  ctx: TenantContext,
  scope: RefreshScope,
  correlationId: string,
): Promise<{ accounts: number; posts: number }> {
  if (scope.workspaceId) assertCan(ctx, 'report:generate', { workspaceId: scope.workspaceId });
  else if (!canSomewhere(ctx, 'report:generate')) assertCan(ctx, 'report:generate');

  const limit = await takeToken(`ratelimit:analytics-refresh:org:${ctx.organizationId}`, {
    capacity: 1,
    refillWindowMs: COOLDOWN_MS,
  });
  if (!limit.allowed) {
    throw new RateLimitedError('Analytics refresh is rate limited', {
      retryAfterSeconds: Math.ceil(limit.retryAfterMs / 1_000),
      userMessage: `Figures were just refreshed. Try again in ${Math.ceil(
        limit.retryAfterMs / 60_000,
      )} min.`,
    });
  }

  const accessible = accessibleWorkspaceIds(ctx);
  const workspaceFilter = {
    ...(accessible === 'ALL' ? {} : { workspaceId: { in: [...accessible] } }),
  };

  // One after the other: queries inside one tenant transaction are not run in
  // parallel anyway, and saying so keeps it from looking like they are.
  const { accounts, variants } = await withTenant(ctx, async (db) => ({
    accounts: await db.socialAccount.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        ...workspaceFilter,
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        ...(scope.socialAccountId ? { id: scope.socialAccountId } : {}),
      },
      select: { id: true, platform: true, accountType: true },
      take: MAX_ACCOUNTS,
    }),
    variants: await db.postVariant.findMany({
      where: {
        deletedAt: null,
        status: 'PUBLISHED',
        publishedAt: { gte: new Date(Date.now() - POST_LOOKBACK_MS) },
        socialAccount: { deletedAt: null, status: 'ACTIVE' },
        ...(scope.socialAccountId ? { socialAccountId: scope.socialAccountId } : {}),
        post: {
          deletedAt: null,
          ...workspaceFilter,
          ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
        },
      },
      select: { id: true, socialAccountId: true },
      orderBy: { publishedAt: 'desc' },
      take: MAX_POSTS,
    }),
  }));

  ensureProvidersRegistered();
  const measurable = accounts.filter((account) => {
    try {
      return capabilitiesFor(account.platform, account.accountType).analytics.account;
    } catch {
      return false;
    }
  });

  // One job per subject per press. Named, so a second press inside the same
  // window — the limiter should prevent it, but a retry could not — adds nothing.
  const window = Math.floor(Date.now() / COOLDOWN_MS);

  for (const account of measurable) {
    await enqueue(
      'analytics',
      { organizationId: ctx.organizationId, correlationId, socialAccountId: account.id },
      { jobId: `analytics-refresh-account-${account.id}-${window}` },
    );
  }

  for (const variant of variants) {
    await enqueue(
      'analytics',
      {
        organizationId: ctx.organizationId,
        correlationId,
        socialAccountId: variant.socialAccountId,
        postVariantId: variant.id,
      },
      { jobId: `analytics-refresh-post-${variant.id}-${window}` },
    );
  }

  logger.info('analytics refresh requested', {
    organizationId: ctx.organizationId,
    accounts: measurable.length,
    posts: variants.length,
    correlationId,
  });

  return { accounts: measurable.length, posts: variants.length };
}
