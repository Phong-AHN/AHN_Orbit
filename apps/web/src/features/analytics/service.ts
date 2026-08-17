import { type TenantContext, accessibleWorkspaceIds } from '@orbit/core';
import { withTenant } from '@orbit/db';

/**
 * Reading what the worker captured (T3.3, SRS §18).
 *
 * **This module never calls a provider.** Ingestion is the worker's job and it
 * runs on a cadence; a page load that could trigger a Graph call would put
 * Meta's per-app rate limit — the same quota publishing spends — behind a
 * refresh button. Everything here reads rows.
 *
 * **`availability` travels with every number.** A metric that Facebook has
 * withdrawn is reported as withdrawn, not as zero, all the way to the UI. A nought
 * in a client report is a statement that nobody engaged, which is a different
 * thing from "the platform stopped publishing this figure" — and the client
 * will act on the first.
 */

export type MetricAvailability = 'AVAILABLE' | 'UNSUPPORTED' | 'DEPRECATED' | 'ERROR';

export interface MetricReading {
  metrics: Record<string, number>;
  availability: Record<string, MetricAvailability>;
  providerApiVersion: string;
}

export interface AnalyticsRange {
  from: Date;
  to: Date;
}

/**
 * A day series for one account.
 *
 * Ordered oldest first, which is the order a chart wants and the opposite of
 * every other listing in the product — hence saying so rather than leaving the
 * caller to discover it.
 */
export async function getAccountAnalytics(
  ctx: TenantContext,
  socialAccountId: string,
  range: AnalyticsRange,
) {
  return withTenant(ctx, (db) =>
    db.analyticsSnapshot.findMany({
      where: {
        socialAccountId,
        date: { gte: startOfUtcDay(range.from), lte: startOfUtcDay(range.to) },
      },
      select: {
        date: true,
        metrics: true,
        availability: true,
        providerApiVersion: true,
      },
      orderBy: { date: 'asc' },
    }),
  );
}

export interface PostAnalyticsFilter {
  workspaceId?: string;
  brandId?: string;
  /** Restricts to posts this principal authored, for the CONTENT_CREATOR grant. */
  authoredBy?: string;
  limit?: number;
}

/**
 * The latest reading for each published variant in a window.
 *
 * "Latest" rather than "all": the table keeps every capture so a number has a
 * history, but a leaderboard wants one row per post. The history is still there
 * for anything that needs to draw a line.
 *
 * Scoping is layered and each layer is doing separate work — the tenant client
 * bounds the organization, `accessibleWorkspaces` bounds a workspace-scoped
 * role, and `authoredBy` bounds a Content Creator to their own posts (**O3**:
 * creators see their own results so they can learn from them).
 */
export async function listPostAnalytics(
  ctx: TenantContext,
  range: AnalyticsRange,
  filter: PostAnalyticsFilter = {},
) {
  const accessible = accessibleWorkspaceIds(ctx);

  const variants = await withTenant(ctx, (db) =>
    db.postVariant.findMany({
      where: {
        deletedAt: null,
        status: 'PUBLISHED',
        publishedAt: { gte: range.from, lte: range.to },
        // Every workspace predicate lives inside this one `post` object. Adding
        // a second `post` key alongside it would silently win over this one —
        // object spread, last key takes the field — and the scoping would
        // vanish without a type error to say so.
        post: {
          deletedAt: null,
          ...(accessible === 'ALL' ? {} : { workspaceId: { in: [...accessible] } }),
          ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
          ...(filter.brandId ? { brandId: filter.brandId } : {}),
          ...(filter.authoredBy ? { createdById: filter.authoredBy } : {}),
        },
      },
      select: {
        id: true,
        platform: true,
        publishedAt: true,
        externalPermalink: true,
        post: { select: { id: true, title: true, body: true, brandId: true } },
        socialAccount: { select: { id: true, displayName: true, handle: true } },
        // One row: the newest capture. The rest of the history stays in the
        // table for anything that wants to draw a line rather than a total.
        analytics: {
          select: { capturedAt: true, metrics: true, availability: true, providerApiVersion: true },
          orderBy: { capturedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { publishedAt: 'desc' },
      take: Math.min(filter.limit ?? 50, 200),
    }),
  );

  return variants.map((variant) => {
    const latest = variant.analytics[0];

    return {
      variantId: variant.id,
      platform: variant.platform,
      publishedAt: variant.publishedAt,
      permalink: variant.externalPermalink,
      post: variant.post,
      account: variant.socialAccount,
      // `null` where nothing has been captured yet, which is a different state
      // from "captured and empty" and reads differently in the UI.
      reading: latest
        ? {
            capturedAt: latest.capturedAt,
            metrics: latest.metrics as Record<string, number>,
            availability: latest.availability as Record<string, MetricAvailability>,
            providerApiVersion: latest.providerApiVersion,
          }
        : null,
    };
  });
}

export interface AnalyticsOverview {
  posts: number;
  accounts: number;
  totals: Record<string, number>;
  /**
   * Metrics that exist but could not be totalled, and why. Presented instead of
   * a zero, because §18 asks for unavailable to be *clearly indicated*.
   */
  unavailable: Record<string, MetricAvailability>;
}

/**
 * Organization-level totals for a window.
 *
 * Summed here rather than in SQL because the numbers live in a JSON column and
 * their names vary by platform — a Facebook `post_media_view` and an Instagram
 * `views` are both "how many saw it", and deciding they are the same number is
 * a reporting decision, not a database one. This deliberately does **not** make
 * that decision: it totals each metric name separately and lets the surface
 * that displays them choose what to call what.
 *
 * A metric that is unavailable anywhere is reported in `unavailable` and left
 * out of `totals`, so a partial sum can never masquerade as a complete one.
 */
export async function getAnalyticsOverview(
  ctx: TenantContext,
  range: AnalyticsRange,
  filter: { workspaceId?: string } = {},
): Promise<AnalyticsOverview> {
  const readings = await listPostAnalytics(ctx, range, {
    ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
    limit: 200,
  });

  const totals: Record<string, number> = {};
  const unavailable: Record<string, MetricAvailability> = {};
  const accounts = new Set<string>();

  for (const row of readings) {
    accounts.add(row.account.id);
    if (!row.reading) continue;

    for (const [name, value] of Object.entries(row.reading.metrics)) {
      totals[name] = (totals[name] ?? 0) + value;
    }

    for (const [name, state] of Object.entries(row.reading.availability)) {
      if (state === 'AVAILABLE') continue;
      // First reason wins; they are all "this number is not a number".
      unavailable[name] ??= state;
    }
  }

  // A metric that is both summed and flagged is available somewhere and not
  // elsewhere. The total would be over a subset, so it does not get to be a
  // total — the flag is the honest answer.
  for (const name of Object.keys(unavailable)) delete totals[name];

  return { posts: readings.length, accounts: accounts.size, totals, unavailable };
}

/** UTC midnight, matching how the worker buckets a day. */
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
