import { newCorrelationId, isUserPrincipal, type TenantContext } from '@orbit/core';
import { explanationIsGrounded, type AIProvider, type PerformanceFact } from '@orbit/ai';
import { clock } from '@orbit/core';
import { getCreditStatus, runGeneration } from '@/features/ai/service';
import { getAnalyticsOverview, listPostAnalytics, type AnalyticsRange } from './service';
import { bestPostingTimes, engagementOf } from './insights';

/**
 * Best posting times and explained performance (D-109 §8.3–8.4).
 *
 * Both read only what the analytics routes already let the caller read —
 * `listPostAnalytics` narrows to accessible workspaces, and a Content Creator
 * sees only their own posts, exactly as on the analytics page.
 */

const DAY_MS = 24 * 60 * 60_000;

function ownOnly(ctx: TenantContext): string | undefined {
  return isUserPrincipal(ctx.principal) && ctx.principal.organizationRole === 'CONTENT_CREATOR'
    ? ctx.principal.userId
    : undefined;
}

export async function getBestPostingTimes(
  ctx: TenantContext,
  filter: { workspaceId?: string; brandId?: string; socialAccountId?: string },
  timeZone: string,
) {
  const to = clock.now();
  const range = { from: new Date(to.getTime() - 90 * DAY_MS), to };
  const authoredBy = ownOnly(ctx);
  const rows = await listPostAnalytics(ctx, range, {
    ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
    ...(filter.brandId ? { brandId: filter.brandId } : {}),
    ...(authoredBy ? { authoredBy } : {}),
    limit: 200,
  });

  const posts = rows
    .filter(
      (row) =>
        row.publishedAt && (!filter.socialAccountId || row.account.id === filter.socialAccountId),
    )
    .map((row) => ({
      accountId: row.account.id,
      accountName: row.account.displayName ?? row.account.handle ?? row.platform,
      platform: row.platform,
      publishedAt: row.publishedAt!,
      engagement: engagementOf(row.reading),
    }));

  return {
    timeZone,
    window: { from: range.from.toISOString(), to: range.to.toISOString() },
    method:
      'Average interactions (reactions, comments, shares, saves, clicks) per post, by weekday and hour, over the last 90 days. Views are not counted.',
    accounts: bestPostingTimes(posts, timeZone),
  };
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Explain a period against the one before it.
 *
 * The figures are computed here and returned whatever the model says. The
 * model only writes prose over them, and prose containing a number that is
 * not in the figures is dropped — the caller then has the table alone, which
 * is true, rather than a sentence that might not be.
 */
export async function explainPerformance(
  ctx: TenantContext,
  input: { brandId: string; range: AnalyticsRange },
  provider: AIProvider,
) {
  const length = input.range.to.getTime() - input.range.from.getTime();
  const previous = { from: new Date(input.range.from.getTime() - length), to: input.range.from };
  const authoredBy = ownOnly(ctx);
  const filter = { brandId: input.brandId, ...(authoredBy ? { authoredBy } : {}) };

  const [now, before, posts] = await Promise.all([
    getAnalyticsOverview(ctx, input.range, filter),
    getAnalyticsOverview(ctx, previous, filter),
    listPostAnalytics(ctx, input.range, { ...filter, limit: 200 }),
  ]);

  const names = [...new Set([...Object.keys(now.totals), ...Object.keys(before.totals)])].sort();
  const facts: PerformanceFact[] = [
    { label: 'posts published', current: now.posts, previous: before.posts },
    ...names.map((name) => ({
      label: name,
      current: name in now.unavailable ? null : (now.totals[name] ?? null),
      previous: name in before.unavailable ? null : (before.totals[name] ?? null),
    })),
  ];
  const unavailable = [
    ...new Set([...Object.keys(now.unavailable), ...Object.keys(before.unavailable)]),
  ];

  const topPosts = posts
    .map((row) => ({
      postId: row.post.id,
      text: (row.post.title || row.post.body || '').slice(0, 200),
      platform: row.platform,
      permalink: row.permalink,
      engagement: engagementOf(row.reading),
    }))
    .filter((p) => p.engagement !== null)
    .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0))
    .slice(0, 5);

  const explainInput = {
    brand: null,
    correlationId: ctx.correlationId ?? newCorrelationId(),
    period: { from: dayOf(input.range.from), to: dayOf(input.range.to) },
    previousPeriod: { from: dayOf(previous.from), to: dayOf(previous.to) },
    facts,
    topPosts,
    unavailable,
  };

  const base = {
    period: explainInput.period,
    previousPeriod: explainInput.previousPeriod,
    facts,
    unavailable,
    topPosts,
    note: 'A null figure was not reported by the platform; it is not zero.',
  };

  // Nothing measured either side: nothing to explain, and no credit spent.
  if (
    facts.every(
      (f) => f.label === 'posts published' || (f.current === null && f.previous === null),
    ) &&
    now.posts === 0
  ) {
    return { ...base, explanation: null, explanationRefused: false };
  }

  const result = await runGeneration(
    {
      ctx,
      brandId: input.brandId,
      operation: 'explain_performance',
      correlationId: explainInput.correlationId,
    },
    provider,
    (brand) => provider.explainPerformance({ ...explainInput, brand }),
  );

  const grounded = explanationIsGrounded(result.value, explainInput);
  const credits = await getCreditStatus(ctx);
  return {
    ...base,
    explanation: grounded ? result.value : null,
    // Told, so the agent says "here are the figures" rather than inventing a summary.
    explanationRefused: !grounded,
    creditsRemaining: credits.remaining ?? null,
  };
}
