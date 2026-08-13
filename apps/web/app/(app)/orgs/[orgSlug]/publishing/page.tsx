import type { Metadata } from 'next';
import Link from 'next/link';
import { presentFailure } from '@orbit/core';
import { Badge, Card, CardBody, Empty, PageHeader, PermissionDenied, cn } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { listNeedsReview, listPublishingJobs, publishingSummary } from '@/features/publishing/logs';
import { listAccountsNeedingReconnection } from '@/features/social/service';
import { NeedsReconnectBanner } from '@/features/social/ui/needs-reconnect-banner';
import {
  ACTION_LABEL,
  JOB_STATE_LABEL,
  JOB_STATE_TONE,
  VARIANT_STATE_LABEL,
  VARIANT_STATE_TONE,
  type JobState,
  type VariantPublishState,
} from '@/features/publishing/ui/status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Publishing' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function readParam(
  values: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = values[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The publishing log (SRS §14).
 *
 * Opens on **what needs attention**, not on a chronological dump: parked
 * publishes first, because those are the ones where nothing happens until a
 * person acts. A successful publish is not news.
 */
export default async function PublishingPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const query = await searchParams;

  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'post:read')) {
    return (
      <main id="main" className="mx-auto max-w-5xl px-6 py-10">
        <PermissionDenied action="see publishing logs" />
      </main>
    );
  }

  const view = readParam(query, 'view') ?? 'attention';
  const cursor = readParam(query, 'cursor');

  const [summary, parked, page, broken] = await Promise.all([
    publishingSummary(ctx),
    view === 'attention' ? listNeedsReview(ctx) : Promise.resolve([]),
    listPublishingJobs(ctx, {
      ...(view === 'failed' ? { failedOnly: true } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    // Surfaced here as well as on the accounts page: a broken connection is the
    // commonest cause of the failures below it, and this is where the person
    // investigating them actually is (T1.7).
    listAccountsNeedingReconnection(ctx),
  ]);

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Publishing"
        description="What went out, what did not, and what needs a decision."
      />

      {broken.length > 0 ? (
        <div className="mt-6">
          <NeedsReconnectBanner
            orgSlug={orgSlug}
            accounts={broken}
            canReconnect={pageCan(ctx, 'social_account:reconnect')}
            returnTo={`/orgs/${orgSlug}/publishing`}
          />
        </div>
      ) : null}

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Published" value={summary.published} tone="success" />
        <Stat label="Needs checking" value={summary.needsReview} tone="warning" />
        <Stat label="Failed" value={summary.failed} tone="danger" />
        <Stat label="Scheduled" value={summary.scheduled} tone="neutral" />
      </dl>

      <nav className="mt-6 flex flex-wrap gap-1.5" aria-label="Filter">
        <ViewLink
          orgSlug={orgSlug}
          view="attention"
          label="Needs attention"
          active={view === 'attention'}
        />
        <ViewLink orgSlug={orgSlug} view="failed" label="Failed" active={view === 'failed'} />
        <ViewLink orgSlug={orgSlug} view="all" label="All jobs" active={view === 'all'} />
      </nav>

      {view === 'attention' ? (
        <section className="mt-6" aria-labelledby="needs-review-heading">
          <h2 id="needs-review-heading" className="text-sm font-semibold text-ink">
            Waiting on a decision
          </h2>

          {parked.length === 0 ? (
            <Empty
              className="mt-3"
              title="Nothing needs checking"
              description="When we can't confirm whether a post went out, it appears here for someone to check."
            />
          ) : (
            <ul className="mt-3 space-y-3">
              {parked.map((variant) => (
                <li key={variant.id}>
                  <Card className="border-warning/40">
                    <CardBody>
                      <Link
                        href={`/orgs/${orgSlug}/posts/${variant.post.id}`}
                        className="block focus:outline-none"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                            {variant.post.title ??
                              variant.post.body.trim().slice(0, 60) ??
                              'Untitled post'}
                          </span>
                          <Badge tone="warning">Needs checking</Badge>
                        </div>

                        <p className="mt-1 text-sm text-ink-muted">
                          {variant.socialAccount.displayName} ·{' '}
                          {readErrorMessage(variant.lastError) ??
                            "We couldn't confirm whether this went out."}
                        </p>

                        <p className="mt-1.5 text-xs font-medium text-warning">
                          Open the post to record what you find
                        </p>
                      </Link>
                    </CardBody>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <section className="mt-8" aria-labelledby="jobs-heading">
        <h2 id="jobs-heading" className="text-sm font-semibold text-ink">
          {view === 'failed' ? 'Failed jobs' : 'Recent jobs'}
        </h2>

        {page.jobs.length === 0 ? (
          <Empty
            className="mt-3"
            title={view === 'failed' ? 'No failures' : 'Nothing published yet'}
            description={
              view === 'failed'
                ? 'Publishing has not failed for any account.'
                : 'Publishing jobs appear here once posts start going out.'
            }
          />
        ) : (
          <ul className="mt-3 space-y-2">
            {page.jobs.map((job) => {
              const presentation = presentFailure(job.lastErrorCode);
              const variantState = job.postVariant.status as VariantPublishState;

              return (
                <li key={job.id}>
                  <Card>
                    <CardBody className="flex flex-wrap items-center gap-3">
                      <Badge tone={JOB_STATE_TONE[job.state as JobState] ?? 'neutral'}>
                        {JOB_STATE_LABEL[job.state as JobState] ?? job.state}
                      </Badge>

                      <Link
                        href={`/orgs/${orgSlug}/posts/${job.postVariant.post.id}`}
                        className="min-w-0 flex-1 truncate text-sm font-medium text-ink hover:underline"
                      >
                        {job.postVariant.post.title ??
                          job.postVariant.post.body.trim().slice(0, 50) ??
                          'Untitled post'}
                      </Link>

                      <span className="truncate text-xs text-ink-muted">
                        {job.postVariant.socialAccount.displayName}
                      </span>

                      <Badge tone={VARIANT_STATE_TONE[variantState] ?? 'neutral'}>
                        {VARIANT_STATE_LABEL[variantState] ?? variantState}
                      </Badge>

                      {job.lastErrorCode ? (
                        <span className="w-full text-xs text-ink-muted">
                          {presentation.summary} — {ACTION_LABEL[presentation.action]}
                        </span>
                      ) : null}
                    </CardBody>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}

        {page.nextCursor ? (
          <div className="mt-4">
            <Link
              href={`/orgs/${orgSlug}/publishing?view=${view}&cursor=${page.nextCursor}`}
              className="rounded px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
            >
              Load more →
            </Link>
          </div>
        ) : null}
      </section>
    </main>
  );
}

/** The stored `lastError` is `{ code, message }`; render only the message. */
function readErrorMessage(value: unknown): string | null {
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'warning' | 'danger' | 'neutral';
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd
        className={cn(
          'mt-0.5 text-xl font-semibold tabular-nums',
          tone === 'success' && 'text-success',
          tone === 'warning' && value > 0 && 'text-warning',
          tone === 'danger' && value > 0 && 'text-danger',
          (tone === 'neutral' || value === 0) && 'text-ink',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function ViewLink({
  orgSlug,
  view,
  label,
  active,
}: {
  orgSlug: string;
  view: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={`/orgs/${orgSlug}/publishing?view=${view}`}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-full px-3 py-1.5 text-sm transition-colors',
        active ? 'bg-accent text-accent-ink' : 'bg-surface-sunken text-ink-muted hover:text-ink',
      )}
    >
      {label}
    </Link>
  );
}
