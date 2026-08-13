import type { JobContext } from '@orbit/queue';
import { reportStaleSchedules, sweepDueVariants } from './scheduler.js';

/**
 * Job entry point for the scheduler queue.
 *
 * Thin on purpose: `scheduler.ts` holds the logic and takes no job, so the
 * sweep can be tested against a real database without a queue in the way.
 */
export async function processScheduler({ payload }: JobContext<'scheduler'>): Promise<void> {
  switch (payload.task) {
    case 'sweep-due':
      await sweepDueVariants(payload.correlationId);
      return;
    case 'report-stale':
      await reportStaleSchedules();
      return;
    default: {
      const exhaustive: never = payload.task;
      throw new Error(`Unhandled scheduler task: ${String(exhaustive)}`);
    }
  }
}
