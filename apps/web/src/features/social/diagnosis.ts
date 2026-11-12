/**
 * Why an account was marked as needing reconnection, from the record itself.
 *
 * Every demotion writes a `social_account.health_degraded` audit row with when,
 * what found it, the platform's reason and — from the worker — the commit it
 * was built from (D-114). None of that reached the screen, so each time a
 * YouTube channel dropped the question "why" was answered by guessing. This
 * turns the row into two sentences: what marked it, and, where the timing
 * alone gives the cause away, what that cause is.
 *
 * Pure, so it is tested without a database.
 */

export interface DegradedRecord {
  at: Date;
  actorType: string;
  source?: string;
  reason?: string;
  workerCommit?: string;
}

export function readDegradedRecord(row: {
  createdAt: Date;
  actorType: string;
  after: unknown;
}): DegradedRecord {
  const after =
    row.after && typeof row.after === 'object' && !Array.isArray(row.after)
      ? (row.after as Record<string, unknown>)
      : {};
  const text = (key: string) => (typeof after[key] === 'string' ? after[key] : undefined);
  const source = text('source');
  const reason = text('reason');
  const workerCommit = text('workerCommit');

  return {
    at: row.createdAt,
    actorType: row.actorType,
    ...(source ? { source } : {}),
    ...(reason ? { reason } : {}),
    ...(workerCommit ? { workerCommit } : {}),
  };
}

const SOURCE_LABEL: Record<string, string> = {
  'health-probe': 'the hourly connection check',
  publish: 'a publish attempt',
  'manual-check': 'a check run from this page',
};

/** Google cancels refresh tokens seven days after consent while an app is in Testing. */
const TESTING_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const TESTING_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface Diagnosis {
  /** What marked it, and when. */
  trail: string;
  /** A cause the record itself points at, when there is one. */
  likelyCause?: string;
}

export function diagnose(input: {
  platform: string;
  connectedAt: Date;
  degraded: DegradedRecord;
  formatWhen: (value: Date) => string;
}): Diagnosis {
  const { degraded } = input;
  const by = degraded.source ? (SOURCE_LABEL[degraded.source] ?? degraded.source) : undefined;

  let build = '';
  if (degraded.actorType === 'WORKER') {
    build = degraded.workerCommit
      ? ` (worker build ${degraded.workerCommit})`
      : // Every worker built since 6 Nov records its commit. One that does not
        // is older, and an older worker still taking jobs demotes accounts by
        // rules that have since been fixed (D-114).
        ' — written by a worker that records no build, so one older than 6 Nov is still running';
  }

  const trail = `Marked ${input.formatWhen(degraded.at)}${by ? ` by ${by}` : ''}${build}.`;

  const sinceConnect = degraded.at.getTime() - input.connectedAt.getTime();
  const likelyCause =
    input.platform === 'YOUTUBE' && Math.abs(sinceConnect - TESTING_EXPIRY_MS) <= TESTING_WINDOW_MS
      ? 'It dropped seven days after it was connected. That is Google ending access for an app still in Testing mode: publish the Google Cloud app (Audience → In production), then reconnect.'
      : undefined;

  return { trail, ...(likelyCause ? { likelyCause } : {}) };
}
