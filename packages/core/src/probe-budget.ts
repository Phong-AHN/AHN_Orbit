/**
 * A deadline for a health probe.
 *
 * Exists because a health check that hangs is worse than one that fails. The
 * deep check on a production deployment whose database host was unreachable sat
 * for **90 seconds and returned nothing at all** — the TCP connect was waiting
 * on a host with no reachable address, and the serverless function was killed
 * before any check could report. The one moment the endpoint was needed, it was
 * the only thing that could not answer.
 *
 * So every probe gets a budget, and running out of it is a *result*: the
 * component is reported unreachable rather than the whole response being lost.
 */

export interface ProbeOutcome<T> {
  /** Present when the probe answered inside its budget. */
  value?: T;
  /** True when the budget elapsed first. */
  timedOut: boolean;
  elapsedMs: number;
}

/**
 * Race a probe against its budget.
 *
 * **The losing promise is not cancelled**, and cannot be: neither a Prisma
 * query nor an S3 request takes an abort signal here. It is left to settle and
 * be discarded, which is safe for a read-only probe — nothing is written, and
 * the process is about to answer the request either way. A rejection arriving
 * after the race is swallowed deliberately, because an unhandled rejection
 * would take the process down over a probe nobody is waiting for any more.
 */
export async function withProbeBudget<T>(
  probe: () => Promise<T>,
  budgetMs: number,
): Promise<ProbeOutcome<T>> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const TIMED_OUT = Symbol('probe-timed-out');

  try {
    const running = probe();
    // Attached before the race so a late rejection can never surface as an
    // unhandled rejection after the loser is discarded.
    running.catch(() => undefined);

    const result = await Promise.race([
      running,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), budgetMs);
      }),
    ]);

    if (result === TIMED_OUT) {
      return { timedOut: true, elapsedMs: Date.now() - started };
    }

    return { value: result as T, timedOut: false, elapsedMs: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
