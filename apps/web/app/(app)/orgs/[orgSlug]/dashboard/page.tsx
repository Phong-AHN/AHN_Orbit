import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Alert,
  Badge,
  Card,
  CardBody,
  Empty,
  PageHeader,
  PermissionDenied,
  Section,
  Stat,
  StatGrid,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  buttonClassName,
} from '@orbit/ui';
import { pageCan, pageCanSomewhere, requirePageContext } from '@/server/page-context';
import { dashboardSummary } from '@/features/dashboard/service';
import { myWork } from '@/features/dashboard/my-work';
import { AlertList } from '@/features/dashboard/ui/alert-list';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Today' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

/**
 * One screen that says what to do next (SRS §20).
 *
 * **Composed by role rather than filtered by it.** Somebody whose job is
 * producing content opens to their own queue; somebody running the agency opens
 * to what is stuck. The same page, ordered by whose day it is — which is the
 * difference between a product that feels built for you and one that shows you
 * an owner's dashboard with the parts you cannot use greyed out.
 *
 * Every number links somewhere it can be acted on. A stat that is only a stat
 * is decoration, and this page has none.
 */
export default async function DashboardPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'org:read')) {
    return (
      <main id="main" className="mx-auto max-w-6xl px-6 py-10">
        <PermissionDenied action="see this dashboard" />
      </main>
    );
  }

  const [summary, mine] = await Promise.all([dashboardSummary(ctx), myWork(ctx)]);

  const base = `/orgs/${orgSlug}`;
  const hasOwnWork =
    mine.tasks.length > 0 || mine.drafts.length > 0 || mine.changesRequested.length > 0;

  // Whoever cannot see the agency's aggregate picture is, by definition, here
  // to do their own work — so it leads. For everyone else the org view leads
  // and their own queue follows it.
  const ownWorkFirst = !pageCanSomewhere(ctx, 'social_account:read');

  const ownWork = hasOwnWork ? (
    <Section
      title="Your work"
      description="Assigned to you, or waiting on you."
      actions={
        pageCanSomewhere(ctx, 'post:create') ? (
          <Link href={`${base}/posts/new`} className={buttonClassName({ size: 'sm' })}>
            New post
          </Link>
        ) : null
      }
    >
      {mine.changesRequested.length > 0 ? (
        <Alert
          tone="warning"
          title={`${mine.changesRequested.length} sent back to you`}
          actions={
            <Link
              href={`${base}/posts?status=CHANGES_REQUESTED`}
              className={buttonClassName({ variant: 'secondary', size: 'sm' })}
            >
              Open
            </Link>
          }
        >
          A reviewer asked for changes. Nothing moves until you resubmit.
        </Alert>
      ) : null}

      {mine.tasks.length > 0 ? (
        <Table caption="Production tasks assigned to you">
          <THead>
            <TR>
              <TH>Task</TH>
              <TH>Post</TH>
              <TH>Due</TH>
            </TR>
          </THead>
          <TBody>
            {mine.tasks.map((task) => (
              <TR key={task.id}>
                <TD>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-ink">{humanise(task.stage)}</span>
                    <Badge tone={task.state === 'BLOCKED' ? 'danger' : 'neutral'}>
                      {humanise(task.state)}
                    </Badge>
                    {task.blocking ? <Badge tone="warning">Blocks review</Badge> : null}
                  </span>
                </TD>
                <TD>
                  <Link href={`${base}/posts/${task.post.id}`} className="text-ink hover:underline">
                    {title(task.post)}
                  </Link>
                </TD>
                <TD>
                  {task.dueAt ? (
                    <span className={task.overdue ? 'font-semibold text-danger' : undefined}>
                      {task.dueAt.toISOString().slice(0, 10)}
                      {task.overdue ? ' · overdue' : ''}
                    </span>
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : null}

      {mine.drafts.length > 0 ? (
        <Card>
          <CardBody>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
              Your drafts
            </p>
            <ul className="space-y-1">
              {mine.drafts.map((draft) => (
                <li key={draft.id}>
                  <Link
                    href={`${base}/posts/${draft.id}`}
                    className="text-sm text-ink hover:underline"
                  >
                    {title(draft)}
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}
    </Section>
  ) : null;

  const orgPicture = (
    <>
      <StatGrid>
        <Stat
          label="Waiting for approval"
          value={summary.totals.awaitingApproval}
          hint="Across your clients"
          href={`${base}/approvals`}
        />
        <Stat
          label="Scheduled"
          value={summary.totals.scheduled}
          hint="Queued to go out"
          href={`${base}/calendar`}
        />
        <Stat
          label="Published this week"
          value={summary.totals.publishedThisWeek}
          hint="Last seven days"
          href={`${base}/publishing`}
        />
        <Stat
          label="Needs attention"
          value={summary.totals.needsAttention}
          tone={summary.totals.needsAttention > 0 ? 'danger' : 'neutral'}
          hint="Failed or parked"
          href={`${base}/publishing`}
        />
      </StatGrid>

      <Section title="Needs attention" className="mt-8">
        <AlertList alerts={summary.alerts} orgSlug={orgSlug} />
      </Section>

      <Section title="Next out" className="mt-8">
        {summary.nextPost ? (
          <Card>
            <CardBody>
              <Link
                href={`${base}/posts/${summary.nextPost.id}`}
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
                  }).format(summary.nextPost.scheduledFor)}{' '}
                  · {summary.nextPost.timezone ?? organization.timezone}
                </p>
              ) : null}
            </CardBody>
          </Card>
        ) : (
          <Empty
            title="Nothing scheduled"
            description="Once something is scheduled, the next one out shows here."
            {...(pageCanSomewhere(ctx, 'post:create')
              ? {
                  action: (
                    <Link href={`${base}/posts/new`} className={buttonClassName({ size: 'sm' })}>
                      Write a post
                    </Link>
                  ),
                }
              : {})}
          />
        )}
      </Section>

      {summary.workspaces.length > 0 ? (
        <Section title="Clients" className="mt-8">
          <Table caption="Content by client">
            <THead>
              <TR>
                <TH>Client</TH>
                <TH align="right">Drafts</TH>
                <TH align="right">Awaiting approval</TH>
                <TH align="right">Scheduled</TH>
                <TH align="right">Needs attention</TH>
              </TR>
            </THead>
            <TBody>
              {summary.workspaces.map((workspace) => (
                <TR key={workspace.id}>
                  <TD className="font-medium text-ink">{workspace.name}</TD>
                  <TD className="text-right tabular-nums">{workspace.counts['DRAFT'] ?? 0}</TD>
                  <TD className="text-right tabular-nums">{workspace.awaitingApproval}</TD>
                  <TD className="text-right tabular-nums">{workspace.scheduled}</TD>
                  <TD
                    className={`text-right tabular-nums ${
                      workspace.needsAttention > 0 ? 'font-semibold text-danger' : ''
                    }`}
                  >
                    {workspace.needsAttention}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Section>
      ) : null}

      {summary.accountHealth ? (
        <Section title="Connected accounts" className="mt-8">
          {summary.accountHealth.needsReconnect > 0 ? (
            <Alert
              tone="warning"
              title={`${summary.accountHealth.needsReconnect} need reconnecting`}
              actions={
                <Link
                  href={`${base}/settings/accounts`}
                  className={buttonClassName({ variant: 'secondary', size: 'sm' })}
                >
                  Fix
                </Link>
              }
            >
              Publishing to these will fail until somebody signs in again.
            </Alert>
          ) : (
            <Card>
              <CardBody className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-ink-secondary">
                  {summary.accountHealth.active} connected and healthy
                  {summary.accountHealth.disconnected > 0
                    ? `, ${summary.accountHealth.disconnected} disconnected`
                    : ''}
                  .
                </p>
                <Link
                  href={`${base}/settings/accounts`}
                  className="text-sm font-medium text-accent hover:underline"
                >
                  Manage accounts →
                </Link>
              </CardBody>
            </Card>
          )}
        </Section>
      ) : null}
    </>
  );

  return (
    <main id="main" className="mx-auto max-w-6xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Today"
        description="What needs attention, and what is going out."
      />

      <div className="mt-6 space-y-8">
        {ownWorkFirst ? (
          <>
            {ownWork}
            {orgPicture}
          </>
        ) : (
          <>
            {orgPicture}
            {ownWork}
          </>
        )}
      </div>
    </main>
  );
}

function title(post: { title: string | null; body: string }): string {
  return post.title ?? post.body.trim().slice(0, 60) ?? 'Untitled post';
}

/** `IN_PROGRESS` → `In progress`. Enum values are ours; nobody should read one. */
function humanise(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' ');
}
