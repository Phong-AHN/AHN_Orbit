import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, Card, CardBody, PageHeader } from '@orbit/ui';
import { requirePlatformAdmin } from '@/server/admin-context';
import { platformHealth } from '@/features/admin/service';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Platform health' };

/** How long a queue may have work waiting before it is worth a second look. */
const BACKLOG_WARNING_MS = 5 * 60 * 1_000;

/**
 * Is the platform working? (SRS §28)
 *
 * Queue depth alone is a poor alarm — 500 fast jobs is healthy and three stuck
 * ones are not — so the age of the oldest waiting job is given equal weight.
 */
export default async function AdminHealthPage() {
  await requirePlatformAdmin('admin:view_jobs');

  const health = await platformHealth();

  return (
    <main id="main" className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader title="Platform health" description="Queues, dead letters and scale." />

      <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Organizations" value={health.totals.organizations} />
        <Stat label="Users" value={health.totals.users} />
        <Stat label="Connections" value={health.totals.socialAccounts} />
        <Stat label="Dead letters" value={health.deadLetters} warn={health.deadLetters > 0} />
      </dl>

      <div className="mt-6">
        <Card className={health.database.reachable ? undefined : 'border-danger/40'}>
          <CardBody className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-ink">Database</span>
            <Badge tone={health.database.reachable ? 'success' : 'danger'}>
              {health.database.reachable ? 'Reachable' : 'Unreachable'}
            </Badge>
          </CardBody>
        </Card>
      </div>

      <section className="mt-8" aria-labelledby="queues-heading">
        <h2 id="queues-heading" className="text-sm font-semibold text-ink">
          Queues
        </h2>

        <Card className="mt-3">
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-muted">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Queue
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Waiting
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Active
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Delayed
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Failed
                  </th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">
                    Oldest waiting
                  </th>
                </tr>
              </thead>
              <tbody>
                {health.queues.map((queue) => (
                  <tr key={queue.queue} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5 font-medium text-ink">{queue.queue}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                      {queue.waiting}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                      {queue.active}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-ink-secondary">
                      {queue.delayed}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right tabular-nums ${
                        queue.failed > 0 ? 'font-semibold text-danger' : 'text-ink-secondary'
                      }`}
                    >
                      {queue.failed}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right tabular-nums ${
                        queue.oldestWaitingMs > BACKLOG_WARNING_MS
                          ? 'font-semibold text-warning'
                          : 'text-ink-secondary'
                      }`}
                    >
                      {queue.oldestWaitingMs > 0 ? formatAge(queue.oldestWaitingMs) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      </section>

      {health.deadLetters > 0 ? (
        <p className="mt-4 text-sm">
          <Link href="/admin/jobs" className="font-medium text-accent hover:underline">
            {health.deadLetters} dead letter{health.deadLetters === 1 ? '' : 's'} to look at →
          </Link>
        </p>
      ) : null}
    </main>
  );
}

function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd
        className={`mt-0.5 text-xl font-semibold tabular-nums ${warn ? 'text-danger' : 'text-ink'}`}
      >
        {value}
      </dd>
    </div>
  );
}
