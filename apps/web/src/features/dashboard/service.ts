import {
  STALE_SCHEDULE_MS,
  accessibleWorkspaceIds,
  clock,
  type PostStatus,
  type TenantContext,
} from '@orbit/core';
import { withTenant, type TenantDb } from '@orbit/db';
import { can } from '@orbit/rbac';
import { collectAlerts, type Alert } from './alerts';

/**
 * The agency dashboard (SRS §20, T1.17).
 *
 * One screen answering one question: what needs attention today.
 *
 * ## Why this file is written the way it is
 *
 * The task's definition of done is "aggregation is a single grouped query, not
 * N+1", and that constraint shapes everything here. The obvious implementation —
 * list the workspaces, then count posts per workspace — is one query per client,
 * which is fine with three clients and a problem with sixty. So the per-client
 * figures come from **one `groupBy(['workspaceId', 'status'])`** and are
 * stitched together in memory.
 *
 * The whole dashboard is a **fixed number of queries regardless of how many
 * workspaces, accounts or posts exist**. An integration test pins that by
 * running it against two workspaces and then six and asserting the query count
 * is identical — which is the property worth testing, rather than a magic
 * number that changes whenever a section is added.
 *
 * ## Scope
 *
 * Every query is narrowed by `accessibleWorkspaceIds`, so an Account Manager's
 * dashboard counts only their clients while an Owner's counts everything. That
 * is the same helper the publishing log and the approval queue use — the
 * dashboard must not be a way to learn the shape of workspaces you cannot open.
 */

/** Names quoted in an alert before it stops listing and starts counting. */
const EXAMPLE_LIMIT = 3;

/** How long a review may sit before it is a backlog rather than a queue. */
const APPROVAL_BACKLOG_MS = 24 * 60 * 60 * 1_000;

export interface WorkspaceSummary {
  id: string;
  name: string;
  /** Counts by post status. Absent statuses are zero rather than missing. */
  counts: Record<string, number>;
  needsAttention: number;
  awaitingApproval: number;
  scheduled: number;
  published: number;
}

export interface AccountHealthSummary {
  active: number;
  needsReconnect: number;
  disconnected: number;
  /** The broken ones, by name, so the alert can be specific. */
  broken: Array<{ id: string; displayName: string; workspaceId: string }>;
}

export interface NextPost {
  id: string;
  title: string | null;
  body: string;
  scheduledFor: Date | null;
  timezone: string | null;
  workspaceId: string;
}

export interface DashboardSummary {
  workspaces: WorkspaceSummary[];
  alerts: Alert[];
  accountHealth: AccountHealthSummary | null;
  nextPost: NextPost | null;
  totals: {
    awaitingApproval: number;
    scheduled: number;
    publishedThisWeek: number;
    needsAttention: number;
  };
}

/**
 * Everything the dashboard shows, in one call.
 *
 * The sections run concurrently rather than sequentially: they are independent
 * reads inside one tenant transaction, and a dashboard that takes the sum of its
 * parts to load is a dashboard people stop opening.
 */
export async function dashboardSummary(ctx: TenantContext): Promise<DashboardSummary> {
  const now = clock.now();
  const workspaces = accessibleWorkspaceIds(ctx);

  // Account health is a separate right from reading posts. A Content Creator
  // sees the content picture and not the connection one — the same split the
  // grant matrix already makes (docs/RBAC.md §4.3).
  const mayReadAccounts = can(ctx, 'social_account:read', {});

  const postScope = {
    deletedAt: null,
    ...(workspaces === 'ALL' ? {} : { workspaceId: { in: [...workspaces] } }),
  };

  return withTenant(ctx, async (db) => {
    const [
      byWorkspace,
      workspaceRows,
      variantCounts,
      approvalBacklog,
      overdue,
      accountHealth,
      nextPost,
      publishedThisWeek,
    ] = await Promise.all([
      // ── The one query that would otherwise have been N ──────────────────
      db.post.groupBy({
        by: ['workspaceId', 'status'],
        where: postScope,
        _count: { _all: true },
      }),

      db.workspace.findMany({
        where: {
          deletedAt: null,
          ...(workspaces === 'ALL' ? {} : { id: { in: [...workspaces] } }),
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),

      db.postVariant.groupBy({
        by: ['status'],
        where: { deletedAt: null, post: postScope },
        _count: { _all: true },
      }),

      // Count and age together, so "how long has this been waiting" costs
      // nothing extra.
      db.approval.groupBy({
        by: ['stage'],
        where: { state: 'PENDING', post: postScope },
        _count: { _all: true },
        _min: { requestedAt: true },
      }),

      db.postVariant.count({
        where: {
          status: 'SCHEDULED',
          deletedAt: null,
          scheduledFor: { lt: new Date(now.getTime() - STALE_SCHEDULE_MS) },
          post: postScope,
        },
      }),

      mayReadAccounts ? loadAccountHealth(db, workspaces) : Promise.resolve(null),

      db.post.findFirst({
        where: { ...postScope, status: 'SCHEDULED', scheduledFor: { gte: now } },
        select: {
          id: true,
          title: true,
          body: true,
          scheduledFor: true,
          timezone: true,
          workspaceId: true,
        },
        orderBy: { scheduledFor: 'asc' },
      }),

      db.post.count({
        where: {
          ...postScope,
          status: { in: ['PUBLISHED', 'PARTIALLY_PUBLISHED'] },
          publishedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) },
        },
      }),
    ]);

    // ── Stitch the grouped rows onto the workspaces, in memory ─────────────
    const countsByWorkspace = new Map<string, Record<string, number>>();

    for (const row of byWorkspace) {
      const bucket = countsByWorkspace.get(row.workspaceId) ?? {};
      bucket[row.status] = row._count._all;
      countsByWorkspace.set(row.workspaceId, bucket);
    }

    const summaries: WorkspaceSummary[] = workspaceRows.map((workspace) => {
      const counts = countsByWorkspace.get(workspace.id) ?? {};
      return {
        id: workspace.id,
        name: workspace.name,
        counts,
        awaitingApproval: at(counts, 'INTERNAL_REVIEW') + at(counts, 'CLIENT_REVIEW'),
        scheduled: at(counts, 'SCHEDULED'),
        published: at(counts, 'PUBLISHED') + at(counts, 'PARTIALLY_PUBLISHED'),
        needsAttention:
          at(counts, 'FAILED') +
          at(counts, 'CHANGES_REQUESTED') +
          at(counts, 'PARTIALLY_PUBLISHED'),
      };
    });

    const variants = Object.fromEntries(
      variantCounts.map((row) => [row.status, row._count._all]),
    ) as Record<string, number>;

    const pendingApprovals = approvalBacklog.reduce((sum, row) => sum + row._count._all, 0);
    const oldestApproval = approvalBacklog
      .map((row) => row._min.requestedAt)
      .filter((value): value is Date => value !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    // Only a backlog once something has actually been waiting. A review
    // submitted ten minutes ago is a queue working normally.
    const backlogged =
      oldestApproval && now.getTime() - oldestApproval.getTime() >= APPROVAL_BACKLOG_MS
        ? pendingApprovals
        : 0;

    const alerts = collectAlerts(
      [
        {
          kind: 'ACCOUNT_NEEDS_RECONNECT',
          count: accountHealth?.needsReconnect ?? 0,
          examples: accountHealth?.broken.map((account) => account.displayName) ?? [],
        },
        { kind: 'PUBLISH_NEEDS_REVIEW', count: at(variants, 'NEEDS_REVIEW') },
        { kind: 'PUBLISH_FAILED', count: at(variants, 'FAILED') },
        { kind: 'SCHEDULE_OVERDUE', count: overdue },
        {
          kind: 'APPROVAL_BACKLOG',
          count: backlogged,
          oldestAt: oldestApproval ?? null,
        },
        { kind: 'ACCOUNT_DISCONNECTED', count: accountHealth?.disconnected ?? 0 },
      ],
      now,
    );

    return {
      workspaces: summaries,
      alerts,
      accountHealth,
      nextPost,
      totals: {
        awaitingApproval: pendingApprovals,
        scheduled: summaries.reduce((sum, w) => sum + w.scheduled, 0),
        publishedThisWeek,
        needsAttention: at(variants, 'NEEDS_REVIEW') + at(variants, 'FAILED'),
      },
    };
  });
}

/**
 * Connection health, in two queries that do not scale with account count.
 *
 * A `groupBy` for the totals and a **bounded** list of the broken ones for the
 * alert's names — the list is capped rather than complete, because an alert
 * quoting sixty account names is not an alert.
 */
async function loadAccountHealth(
  db: TenantDb,
  workspaces: 'ALL' | readonly string[],
): Promise<AccountHealthSummary> {
  const scope = {
    deletedAt: null,
    ...(workspaces === 'ALL' ? {} : { workspaceId: { in: [...workspaces] } }),
  };

  const [grouped, broken] = await Promise.all([
    db.socialAccount.groupBy({
      by: ['status'],
      where: scope,
      _count: { _all: true },
    }),
    db.socialAccount.findMany({
      where: { ...scope, status: 'NEEDS_RECONNECT' },
      select: { id: true, displayName: true, workspaceId: true },
      orderBy: { displayName: 'asc' },
      take: EXAMPLE_LIMIT,
    }),
  ]);

  const counts = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));

  return {
    active: counts.ACTIVE ?? 0,
    needsReconnect: counts.NEEDS_RECONNECT ?? 0,
    // A revoked account was disconnected on purpose. `DISABLED` is a row staged
    // mid-OAuth and is not a connection anyone has made yet, so it is not counted.
    disconnected: counts.REVOKED ?? 0,
    broken,
  };
}

function at(counts: Record<string, number>, key: PostStatus | string): number {
  return counts[key] ?? 0;
}
