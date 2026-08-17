import type { Metadata } from 'next';
import Link from 'next/link';
import { accessibleWorkspaceIds, clock } from '@orbit/core';
import { Badge, Card, CardBody, Empty, PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { getAnalyticsOverview, listPostAnalytics } from '@/features/analytics/service';
import { listWorkspaces } from '@/features/tenancy/service';
import { MetricStrip, OverviewTotals } from '@/features/analytics/ui/metric-grid';
import { listReports } from '@/features/reports/service';
import { ReportPanel } from '@/features/reports/ui/report-panel';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Analytics' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ workspaceId?: string; days?: string }>;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOWS = [7, 30, 90] as const;

/**
 * What the published work did (T3.4, SRS §18).
 *
 * Reads stored rows only. The numbers refresh on the worker's cadence — six
 * hours for a recent post, daily after that — so this page is never waiting on
 * a provider, and reloading it does not spend the Meta quota that publishing
 * shares.
 */
export default async function AnalyticsPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const { workspaceId, days } = await searchParams;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'analytics:read', workspaceId ? { workspaceId } : {})) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <PermissionDenied action="see analytics" />
      </main>
    );
  }

  const window = WINDOWS.find((option) => String(option) === days) ?? 30;
  const to = clock.now();
  const range = { from: new Date(to.getTime() - window * DAY_MS), to };

  const canGenerate = pageCan(ctx, 'report:generate', workspaceId ? { workspaceId } : {});

  const [overview, posts, workspaces, reports] = await Promise.all([
    getAnalyticsOverview(ctx, range, { ...(workspaceId ? { workspaceId } : {}) }),
    listPostAnalytics(ctx, range, { ...(workspaceId ? { workspaceId } : {}), limit: 50 }),
    listWorkspaces(ctx, accessibleWorkspaceIds(ctx)),
    // Fetched only when this principal may have one, so a Content Creator does
    // not learn what the agency reports to its clients.
    canGenerate ? listReports(ctx) : Promise.resolve([]),
  ]);

  const base = `/orgs/${orgSlug}/analytics`;
  const keep = (next: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    const merged = { workspaceId, days: String(window), ...next };
    if (merged.workspaceId) query.set('workspaceId', merged.workspaceId);
    if (merged.days && merged.days !== '30') query.set('days', merged.days);
    const s = query.toString();
    return s ? `${base}?${s}` : base;
  };

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Analytics"
        description="Results for what has already published. Figures refresh through the day."
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {WINDOWS.map((option) => (
          <Link
            key={option}
            href={keep({ days: String(option) })}
            className={`rounded border px-3 py-1 text-sm ${
              option === window
                ? 'border-accent bg-accent/10 text-ink'
                : 'border-line text-ink-secondary hover:text-ink'
            }`}
          >
            {option} days
          </Link>
        ))}

        {workspaces.length > 1 ? (
          <div className="ml-auto flex flex-wrap gap-2">
            <Link
              href={keep({ workspaceId: undefined })}
              className={`rounded border px-3 py-1 text-sm ${
                workspaceId
                  ? 'border-line text-ink-secondary hover:text-ink'
                  : 'border-accent bg-accent/10 text-ink'
              }`}
            >
              All clients
            </Link>
            {workspaces.map((workspace) => (
              <Link
                key={workspace.id}
                href={keep({ workspaceId: workspace.id })}
                className={`rounded border px-3 py-1 text-sm ${
                  workspaceId === workspace.id
                    ? 'border-accent bg-accent/10 text-ink'
                    : 'border-line text-ink-secondary hover:text-ink'
                }`}
              >
                {workspace.name}
              </Link>
            ))}
          </div>
        ) : null}
      </div>

      <section aria-labelledby="totals-heading" className="mb-8">
        <h2 id="totals-heading" className="mb-2 text-sm font-semibold text-ink">
          Across {overview.posts} posts on {overview.accounts}{' '}
          {overview.accounts === 1 ? 'account' : 'accounts'}
        </h2>
        <OverviewTotals totals={overview.totals} unavailable={overview.unavailable} />
      </section>

      {canGenerate ? (
        <section aria-labelledby="reports-heading" className="mb-8">
          <h2 id="reports-heading" className="sr-only">
            Reports
          </h2>
          <ReportPanel
            orgSlug={orgSlug}
            reports={reports.map((report) => ({
              id: report.id,
              status: report.status,
              format: report.format,
              parameters: (report.parameters ?? {}) as { from?: string; to?: string },
              sizeBytes: report.sizeBytes,
              failureMessage: report.failureMessage,
              expiresAt: report.expiresAt.toISOString(),
              createdAt: report.createdAt.toISOString(),
              requestedBy: report.requestedBy,
            }))}
            range={{
              from: range.from.toISOString().slice(0, 10),
              to: range.to.toISOString().slice(0, 10),
            }}
            {...(workspaceId ? { workspaceId } : {})}
            canGenerate={canGenerate}
            canExport={pageCan(ctx, 'report:export', workspaceId ? { workspaceId } : {})}
          />
        </section>
      ) : null}

      <section aria-labelledby="posts-heading">
        <h2 id="posts-heading" className="mb-2 text-sm font-semibold text-ink">
          By post
        </h2>

        {posts.length === 0 ? (
          <Empty
            title="Nothing published in this range"
            description="Analytics cover posts that have already gone out. Try a longer window."
          />
        ) : (
          <ul className="space-y-2">
            {posts.map((row) => (
              <li key={row.variantId}>
                <Card>
                  <CardBody className="space-y-2">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <Link
                        href={`/orgs/${orgSlug}/posts/${row.post.id}`}
                        className="truncate text-sm font-medium text-ink hover:underline"
                      >
                        {row.post.title ?? (row.post.body.slice(0, 60) || 'Untitled post')}
                      </Link>
                      <Badge tone="neutral">{row.platform}</Badge>
                      <span className="text-xs text-ink-muted">
                        {row.account.displayName}
                        {row.publishedAt ? ` · ${row.publishedAt.toISOString().slice(0, 10)}` : ''}
                      </span>

                      {row.permalink ? (
                        <a
                          href={row.permalink}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto shrink-0 text-xs text-accent hover:underline"
                        >
                          View on {row.platform.toLowerCase()}
                        </a>
                      ) : null}
                    </div>

                    {row.reading ? (
                      <MetricStrip metrics={row.reading.metrics} platform={row.platform} />
                    ) : (
                      <Badge tone="neutral">Not measured yet</Badge>
                    )}
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
