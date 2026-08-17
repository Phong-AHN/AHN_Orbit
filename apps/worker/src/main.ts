import { serverEnv } from '@orbit/config';
import { logger } from '@orbit/observability';
import { platformDb } from '@orbit/db';
import {
  assertWorkerProcess,
  installShutdownHandlers,
  queueFor,
  startWorker,
  type RunningWorker,
} from '@orbit/queue';
import { startHealthServer } from './health.js';
import { processAccountHealth } from './processors/account-health.js';
import { processAnalytics } from './processors/analytics.js';
import { processReport } from './processors/reports.js';
import { processMaintenance } from './processors/maintenance.js';
import { processNotification } from './processors/notifications.js';
import { processPublish } from './processors/publish.js';
import { processScheduler } from './processors/scheduler-job.js';
import { ensureProvidersRegistered } from './providers.js';

/**
 * The worker service (docs/ARCHITECTURE.md §5, T1.11).
 *
 * A separate process from `apps/web`, deployed as its own container. It is the
 * only process permitted to consume jobs — `assertWorkerProcess` refuses to
 * start otherwise, so running the wrong bundle with the wrong role fails
 * loudly at boot rather than quietly double-consuming in production.
 *
 * T1.11 shipped the runtime and the `maintenance` queue; `publish` landed with
 * T1.13, `account-health` with T1.7, `notifications` with T1.15 and `analytics`
 * with T3.1. The `media` processor lands with its feature (T1.8 follow-up); its
 * queue and payload schema already exist, so adding it is a `startWorker`
 * line.
 */

async function main(): Promise<void> {
  // Before anything else: this process must be the worker.
  assertWorkerProcess();

  const env = serverEnv();

  logger.info('worker starting', { nodeVersion: process.version });

  // Fail at boot rather than on the first job if the database is unreachable.
  await platformDb.$queryRaw`SELECT 1`;

  // Adapters must exist before the publish worker takes a job.
  ensureProvidersRegistered();

  const workers: RunningWorker[] = [
    startWorker('publish', processPublish),
    startWorker('account-health', processAccountHealth),
    startWorker('analytics', processAnalytics),
    startWorker('reports', processReport),
    startWorker('notifications', processNotification),
    startWorker('maintenance', processMaintenance),
    startWorker('scheduler', processScheduler),
  ];

  await scheduleRepeatableJobs();

  const health = startHealthServer(env.WORKER_HEALTH_PORT);

  installShutdownHandlers({
    workers,
    exit: (code) => {
      health.close();
      void platformDb.$disconnect().finally(() => {
        process.exit(code);
      });
    },
  });

  logger.info('worker ready', { queues: workers.map((w) => w.name) });
}

/**
 * Repeatable schedules (docs/ARCHITECTURE.md §5.1).
 *
 * BullMQ deduplicates a repeatable job by its key, so every worker instance
 * registering the same schedule produces one series, not one per instance.
 * That is what makes this safe to call unconditionally at boot.
 *
 * Note what is *not* here: per-post delayed jobs. Scheduling is a database
 * query on a 30s sweep (T1.12), because one delayed job per post would make
 * rescheduling and cancellation into queue surgery and stop the database being
 * the source of truth.
 */
async function scheduleRepeatableJobs(): Promise<void> {
  // The 30s sweep (assumption C10). `every` rather than a cron pattern because
  // cron's finest granularity is a minute, and a 60s sweep would double the
  // worst-case publishing lateness.
  const scheduler = queueFor('scheduler');

  await scheduler.add(
    'scheduler',
    { correlationId: 'cron:sweep-due', task: 'sweep-due' },
    { repeat: { every: 30_000 }, jobId: 'cron:sweep-due' },
  );

  await scheduler.add(
    'scheduler',
    { correlationId: 'cron:report-stale', task: 'report-stale' },
    { repeat: { pattern: '*/10 * * * *' }, jobId: 'cron:report-stale' },
  );

  const queue = queueFor('maintenance');

  await queue.add(
    'maintenance',
    { correlationId: 'cron:reconcile-stuck-jobs', task: 'reconcile-stuck-jobs' },
    { repeat: { pattern: '*/5 * * * *' }, jobId: 'cron:reconcile-stuck-jobs' },
  );

  await queue.add(
    'maintenance',
    { correlationId: 'cron:cleanup-staged-accounts', task: 'cleanup-staged-accounts' },
    { repeat: { pattern: '15 * * * *' }, jobId: 'cron:cleanup-staged-accounts' },
  );

  // Hourly, offset from the other housekeeping so they do not all land together.
  // Health is probe-driven because a Page token dies without expiring
  // (docs/SOCIAL_PROVIDERS.md §4) — there is nothing to check but the platform.
  await queue.add(
    'maintenance',
    { correlationId: 'cron:sweep-account-health', task: 'sweep-account-health' },
    { repeat: { pattern: '35 * * * *' }, jobId: 'cron:sweep-account-health' },
  );

  /**
   * Hourly, offset again so nothing lands with the health sweep.
   *
   * Hourly is the *sweep*, not the poll: the sweep only asks "what is stale"
   * and the cadence that decides staleness lives in `sweepAnalytics` — six
   * hours for a recent post, a day for an older one, a day for account totals.
   * Running the sweep more often than the shortest cadence costs one query and
   * keeps the queue smooth instead of bursting every six hours.
   */
  await queue.add(
    'maintenance',
    { correlationId: 'cron:analytics-rollup', task: 'analytics-rollup' },
    { repeat: { pattern: '50 * * * *' }, jobId: 'cron:analytics-rollup' },
  );

  /**
   * Nightly, and at the quietest hour rather than alongside the others.
   *
   * Retention is the only task that deletes, and the only one with no deadline
   * whatsoever — a row that ages out at 03:00 and is removed at 03:00 the next
   * day has harmed nobody. Running it while the platform is idle keeps its
   * batched deletes away from anything a person is waiting on.
   */
  await queue.add(
    'maintenance',
    { correlationId: 'cron:retention', task: 'retention' },
    { repeat: { pattern: '20 3 * * *' }, jobId: 'cron:retention' },
  );

  /**
   * Every two minutes.
   *
   * The outbox is drained often rather than nightly because what it carries is
   * time-sensitive: a failed publish or a stalled approval loses most of its
   * value if it arrives hours late. A pass with nothing owed is one indexed
   * query, so the frequency costs effectively nothing.
   */
  await queue.add(
    'maintenance',
    { correlationId: 'cron:drain-email-outbox', task: 'drain-email-outbox' },
    { repeat: { pattern: '*/2 * * * *' }, jobId: 'cron:drain-email-outbox' },
  );

  logger.info('repeatable jobs registered');
}

export async function start(): Promise<void> {
  await main().catch((error: unknown) => {
    logger.error('worker failed to start', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
