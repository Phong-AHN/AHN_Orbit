import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Empty,
  PageHeader,
  PermissionDenied,
} from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { dashboardSummary } from '@/features/dashboard/service';
import { AlertList } from '@/features/dashboard/ui/alert-list';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Dashboard' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

/**
 * One screen that says what needs attention today (SRS §20, T1.17).
 *
 * Ordered by what a person actually does when they sit down: read the alerts,
 * glance at the clients, check what goes out next. Counts come second because a
 * number nobody acts on is decoration.
 */
export default async function DashboardPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'org:read')) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <PermissionDenied action="see this dashboard" />
      </main>
    );
  }

  const summary = await dashboardSummary(ctx);

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Today"
        description="What needs attention, and what is going out."
      />

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Waiting for approval" value={summary.totals.awaitingApproval} />
        <Stat label="Scheduled" value={summary.totals.scheduled} />
        <Stat label="Published this week" value={summary.totals.publishedThisWeek} />
        <Stat label="Needs attention" value={summary.totals.needsAttention} tone="danger" />
      </dl>

      <section className="mt-8" aria-labelledby="alerts-heading">
        <h2 id="alerts-heading" className="text-sm font-semibold text-ink">
          Needs attention
        </h2>
        <div className="mt-3">
          <AlertList alerts={summary.alerts} orgSlug={orgSlug} />
        </div>
      </section>

      <section className="mt-8" aria-labelledby="next-heading">
        <h2 id="next-heading" className="text-sm font-semibold text-ink">
          Next out
        </h2>

        <div className="mt-3">
          {summary.nextPost ? (
            <Card>
              <CardBody>
                <Link
                  href={`/orgs/${orgSlug}/posts/${summary.nextPost.id}`}
                  className="text-sm font-semibold text-ink hover:underline"
                >
                  {summary.nextPost.title ?? summary.nextPost.body.trim().slice(0, 60)}
                </Link>
                {summary.nextPost.scheduledFor ? (
                  <p className="mt-1 text-xs text-ink-muted">
                    {new Intl.DateTimeFormat('en-GB', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: summary.nextPost.timezone ?? organization.timezone,
                    }).format(summary.nextPost.scheduledFor)}
                  </p>
                ) : null}
              </CardBody>
            </Card>
          ) : (
            <Empty
              title="Nothing scheduled"
              description="Approved posts appear here once they have a date."
            />
          )}
        </div>
      </section>

      <section className="mt-8" aria-labelledby="clients-heading">
        <h2 id="clients-heading" className="text-sm font-semibold text-ink">
          Clients
        </h2>

        <div className="mt-3">
          {summary.workspaces.length === 0 ? (
            <Empty
              title="No clients yet"
              description="Create a workspace for your first client to see their content here."
              action={
                pageCan(ctx, 'workspace:create') ? (
                  <Link href={`/orgs/${orgSlug}/settings/workspaces`}>
                    <Button>Add a client</Button>
                  </Link>
                ) : null
              }
            />
          ) : (
            <Card>
              <CardBody className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-ink-muted">
                      <th scope="col" className="px-4 py-2 font-medium">
                        Client
                      </th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">
                        Awaiting approval
                      </th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">
                        Scheduled
                      </th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">
                        Published
                      </th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">
                        Needs attention
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.workspaces.map((workspace) => (
                      <tr key={workspace.id} className="border-b border-line last:border-0">
                        <td className="px-4 py-2.5 font-medium text-ink">{workspace.name}</td>
                        <Cell value={workspace.awaitingApproval} />
                        <Cell value={workspace.scheduled} />
                        <Cell value={workspace.published} />
                        <Cell value={workspace.needsAttention} tone="danger" />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          )}
        </div>
      </section>

      {summary.accountHealth ? (
        <section className="mt-8" aria-labelledby="accounts-heading">
          <h2 id="accounts-heading" className="sr-only">
            Account health
          </h2>
          <Card>
            <CardHeader>
              <CardTitle>Connected accounts</CardTitle>
            </CardHeader>
            <CardBody>
              <p className="text-sm text-ink-muted">
                {summary.accountHealth.active} connected
                {summary.accountHealth.needsReconnect > 0
                  ? `, ${summary.accountHealth.needsReconnect} needing reconnection`
                  : ''}
                {summary.accountHealth.disconnected > 0
                  ? `, ${summary.accountHealth.disconnected} disconnected`
                  : ''}
                .
              </p>
              <Link
                href={`/orgs/${orgSlug}/settings/accounts`}
                className="mt-2 inline-block text-sm font-medium text-accent hover:underline"
              >
                Manage accounts →
              </Link>
            </CardBody>
          </Card>
        </section>
      ) : null}
    </main>
  );
}

function Cell({ value, tone }: { value: number; tone?: 'danger' }) {
  return (
    <td
      className={`px-4 py-2.5 text-right tabular-nums ${
        tone === 'danger' && value > 0 ? 'font-semibold text-danger' : 'text-ink-secondary'
      }`}
    >
      {value}
    </td>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'danger' }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd
        className={`mt-0.5 text-xl font-semibold tabular-nums ${
          tone === 'danger' && value > 0 ? 'text-danger' : 'text-ink'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
