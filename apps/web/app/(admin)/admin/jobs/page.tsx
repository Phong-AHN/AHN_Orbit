import type { Metadata } from 'next';
import { Badge, Card, CardBody, Empty, PageHeader } from '@orbit/ui';
import { requirePlatformAdmin } from '@/server/admin-context';
import { isRetryableQueue, listJobs } from '@/features/admin/service';
import { JobActions } from '@/features/admin/ui/job-actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Dead letters' };

/**
 * The dead-letter browser (SRS §28, §13).
 *
 * Shows the whole cause chain, because "publish failed" is useless and
 * "publish failed ← provider unavailable ← socket hang up" is not. Every frame
 * was reduced to a safe code and message before it was stored (T1.11), so there
 * is nothing here to sanitise at render time.
 */
export default async function AdminJobsPage() {
  await requirePlatformAdmin('admin:view_jobs');

  const jobs = await listJobs();

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader
        title="Dead letters"
        description="Jobs that will not be retried automatically. Newest first."
      />

      {jobs.length === 0 ? (
        <Empty
          className="mt-8"
          title="Nothing dead-lettered"
          description="Jobs that exhaust their retries or fail unrecoverably appear here."
        />
      ) : (
        <ul className="mt-8 space-y-3">
          {jobs.map((job) => (
            <li key={job.id}>
              <Card className="border-danger/30">
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-ink">
                      {job.queue} · {job.errorCode}
                    </span>
                    <Badge tone="danger">{job.reason}</Badge>
                  </div>

                  <p className="text-sm text-ink-muted">{job.message}</p>

                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-ink-muted sm:grid-cols-4">
                    <Meta label="Attempts" value={String(job.attempts)} />
                    <Meta
                      label="Failed"
                      value={new Date(job.failedAt).toISOString().slice(0, 16)}
                    />
                    <Meta label="Organization" value={job.organizationId ?? 'platform'} />
                    <Meta label="Correlation" value={job.correlationId} />
                  </dl>

                  {job.chain.length > 1 ? (
                    <ol className="space-y-0.5 border-l-2 border-line pl-3 text-xs text-ink-muted">
                      {job.chain.map((frame, index) => (
                        <li key={`${job.id}-${String(index)}`}>
                          <span className="font-medium text-ink-secondary">{frame.code}</span>{' '}
                          {frame.message}
                        </li>
                      ))}
                    </ol>
                  ) : null}

                  <JobActions
                    jobId={job.id}
                    retryable={isRetryableQueue(job.queue) && job.payload !== undefined}
                  />
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="truncate font-mono text-ink-secondary">{value}</dd>
    </div>
  );
}
