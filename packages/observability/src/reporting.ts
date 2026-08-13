import { logError } from './logger.js';
import { redact } from './redact.js';

/**
 * Error reporting — **the seam Sentry arrives through** (SRS §33, T1.19).
 *
 * `SENTRY_DSN` has been in the env schema since T0.1 and no SDK is installed.
 * That is a deliberate stopping point rather than an omission, and it is the
 * same shape as the email seam (**D-034**): the call sites exist, the contract
 * is fixed, and turning it on is a dependency plus an initialiser rather than a
 * refactor of everything that reports an error.
 *
 * Wiring it later is:
 *   1. add `@sentry/node` (worker) and `@sentry/nextjs` (web);
 *   2. call `setErrorReporter(...)` once at boot in each, from the DSN;
 *   3. nothing else — every `reportError` call already routes here.
 *
 * **Why not just install it now:** a reporter that has never delivered to a real
 * project is not "Sentry receiving from both apps", it is a dependency and a
 * claim. Installing an SDK I cannot point at a DSN and watch arrive would make
 * the DoD look satisfied while leaving exactly the same work to do.
 *
 * ## What is guaranteed today
 *
 * Everything that reports through here is **logged**, structured, redacted and
 * correlated — which is the property that actually matters for diagnosis, and
 * which works now. Sentry adds grouping, alerting and release tracking on top.
 */

export interface ErrorReport {
  /** Short, stable description. Becomes the Sentry issue title. */
  message: string;
  error: unknown;
  /** Where it happened: route, queue, processor. */
  scope?: string | undefined;
  /** Structured detail. Redacted before it goes anywhere. */
  context?: Record<string, unknown> | undefined;
  /** Set for anything a person should be woken for. */
  fatal?: boolean | undefined;
}

export type ErrorReporter = (report: ErrorReport) => void;

let reporter: ErrorReporter | null = null;

/**
 * Install a reporter. Call once, at boot, in each deployable.
 *
 * Returns a function that removes it again, so a test can install a spy without
 * leaking it into the next file.
 */
export function setErrorReporter(next: ErrorReporter | null): () => void {
  const previous = reporter;
  reporter = next;
  return () => {
    reporter = previous;
  };
}

export function hasErrorReporter(): boolean {
  return reporter !== null;
}

/**
 * Report an error.
 *
 * **Always logs**, whether or not a reporter is installed — the log is the
 * record, and an external service being absent or unreachable must never be the
 * reason an error went unnoticed. A reporter that throws is swallowed for the
 * same reason: error reporting failing is not a second error worth propagating
 * into a request.
 */
export function reportError(report: ErrorReport): void {
  const context = {
    ...(report.scope !== undefined ? { scope: report.scope } : {}),
    ...(report.fatal ? { fatal: true } : {}),
    ...(report.context ?? {}),
  };

  logError(report.message, report.error, context);

  if (!reporter) return;

  try {
    reporter({
      ...report,
      // Redacted here rather than trusting the reporter: a token that reaches a
      // third party is a token that has left the building.
      context: redact(context) as Record<string, unknown>,
    });
  } catch (failure) {
    logError('error reporter failed', failure, { scope: 'observability' });
  }
}
