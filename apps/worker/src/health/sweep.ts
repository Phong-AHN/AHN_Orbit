import { HEALTH_PROBE_INTERVAL_MS, clock } from '@orbit/core';
import { platformDb } from '@orbit/db';
import { logger } from '@orbit/observability';
import { enqueue } from '@orbit/queue';

/**
 * The account-health sweep (docs/ARCHITECTURE.md §5.1, T1.7).
 *
 * Finds connections nobody has checked lately and queues one probe each. It runs
 * on the `maintenance` queue rather than the `scheduler` one on purpose: the
 * scheduler queue exists to keep the 30-second publish sweep punctual (decision
 * D-025), and a health pass across every account in the platform is exactly the
 * kind of work that would make it late. The sweep itself is only a query plus
 * some enqueues; the provider calls happen on `account-health` at concurrency 2.
 *
 * Like the publish sweep, this is one of the few places that reads unscoped —
 * health is a platform-wide question. Every row carries its own
 * `organizationId`, and the processor derives its tenant from the row rather
 * than from the payload (decision D-021).
 */

export interface HealthSweepResult {
  due: number;
  enqueued: number;
  failed: number;
}

/** How many accounts one pass will queue. A backlog drains over later passes. */
const SWEEP_BATCH = 500;

export async function sweepAccountHealth(correlationId: string): Promise<HealthSweepResult> {
  const now = clock.now();
  const cutoff = new Date(now.getTime() - HEALTH_PROBE_INTERVAL_MS);
  const result: HealthSweepResult = { due: 0, enqueued: 0, failed: 0 };

  const due = await platformDb.socialAccount.findMany({
    where: {
      deletedAt: null,
      // NEEDS_RECONNECT is included deliberately: re-probing is how a
      // connection that was fixed at the platform end gets noticed without
      // anyone having to tell us. DISABLED and REVOKED are excluded — those are
      // states a person put the account into.
      status: { in: ['ACTIVE', 'NEEDS_RECONNECT'] },
      OR: [{ healthCheckedAt: null }, { healthCheckedAt: { lt: cutoff } }],
    },
    select: { id: true, organizationId: true },
    orderBy: { healthCheckedAt: { sort: 'asc', nulls: 'first' } },
    take: SWEEP_BATCH,
  });

  result.due = due.length;
  if (due.length === 0) return result;

  // One id per account per interval, so two workers sweeping at the same moment
  // produce one probe rather than two. BullMQ drops the duplicate add.
  const window = Math.floor(now.getTime() / HEALTH_PROBE_INTERVAL_MS);

  for (const account of due) {
    try {
      await enqueue(
        'account-health',
        {
          organizationId: account.organizationId,
          correlationId,
          socialAccountId: account.id,
        },
        { jobId: `health:${account.id}:${window}` },
      );

      result.enqueued += 1;
    } catch (error) {
      // One bad account must not abandon the rest of the sweep.
      result.failed += 1;
      logger.error('failed to enqueue an account health probe', {
        socialAccountId: account.id,
        organizationId: account.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.enqueued > 0 || result.failed > 0) {
    logger.info('account health sweep complete', { ...result });
  }

  return result;
}
