/**
 * What needs attention today (SRS §20, T1.17).
 *
 * Pure: counts in, sentences out. The dashboard's whole value is that somebody
 * opens it once a morning and knows what to do, so the wording carries most of
 * the weight and is worth being able to test without a database.
 *
 * Two rules run through all of it:
 *
 *  • **Rank by what stops working, not by what looks alarming.** A broken
 *    account means nothing publishes for that client until a person acts; a
 *    single failed post is a smaller problem that reads as a bigger one.
 *  • **An alert names its remedy.** "3 accounts need reconnecting" without a
 *    link is a worry, not a task.
 *
 * An empty alert list is the expected state for a well-run agency, and the
 * dashboard says so rather than inventing filler.
 */

export const ALERT_KINDS = [
  'ACCOUNT_NEEDS_RECONNECT',
  'PUBLISH_NEEDS_REVIEW',
  'PUBLISH_FAILED',
  'SCHEDULE_OVERDUE',
  'APPROVAL_BACKLOG',
  'ACCOUNT_DISCONNECTED',
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export type AlertSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

/**
 * Severity per kind, as a total record.
 *
 * `CRITICAL` is reserved for the two conditions where **nothing moves until a
 * human acts**: a dead credential (every scheduled post on that account is
 * stuck) and a parked publish (decision **D-027** guarantees nothing automated
 * will touch it again). Everything else is a warning — the system is still
 * working, somebody just needs to look.
 */
export const ALERT_SEVERITY: Record<AlertKind, AlertSeverity> = {
  ACCOUNT_NEEDS_RECONNECT: 'CRITICAL',
  PUBLISH_NEEDS_REVIEW: 'CRITICAL',
  PUBLISH_FAILED: 'WARNING',
  SCHEDULE_OVERDUE: 'WARNING',
  APPROVAL_BACKLOG: 'WARNING',
  // A deliberate disconnection is not a fault. It is listed so the count of
  // publishable accounts makes sense, and never as a problem to solve.
  ACCOUNT_DISCONNECTED: 'INFO',
} as const;

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

export interface AlertInput {
  kind: AlertKind;
  count: number;
  /** Oldest item in the group, where "how long has this been true" matters. */
  oldestAt?: Date | null | undefined;
  /** A few names to make the alert concrete. Never the whole set. */
  examples?: readonly string[] | undefined;
}

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  count: number;
  title: string;
  detail: string;
  /** What to do, in the imperative. */
  action: string;
  examples: readonly string[];
  oldestAt: Date | null;
}

/** How many names an alert quotes before it stops listing and starts counting. */
const MAX_EXAMPLES = 3;

export function buildAlert(input: AlertInput, now: Date): Alert {
  const { kind, count } = input;
  const examples = (input.examples ?? []).slice(0, MAX_EXAMPLES);
  const oldestAt = input.oldestAt ?? null;
  const waited = oldestAt ? describeAge(oldestAt, now) : null;

  const base = {
    kind,
    severity: ALERT_SEVERITY[kind],
    count,
    examples,
    oldestAt,
  };

  switch (kind) {
    case 'ACCOUNT_NEEDS_RECONNECT':
      return {
        ...base,
        title: plural(count, 'account needs reconnecting', 'accounts need reconnecting'),
        detail: `Nothing will publish to ${count === 1 ? 'it' : 'them'} until the connection is restored.${
          examples.length > 0 ? ` ${listNames(examples, count)}` : ''
        }`,
        action: 'Reconnect',
      };

    case 'PUBLISH_NEEDS_REVIEW':
      return {
        ...base,
        title: plural(count, 'publish needs checking', 'publishes need checking'),
        // Careful wording: we do not know that these failed, and saying so would
        // contradict the reason they were parked in the first place.
        detail:
          'We could not confirm whether these went out, so we stopped rather than risk posting twice. Nothing further happens until someone records what they find.',
        action: 'Check and record',
      };

    case 'PUBLISH_FAILED':
      return {
        ...base,
        title: plural(count, 'post failed to publish', 'posts failed to publish'),
        detail: waited
          ? `The oldest has been failed for ${waited}.`
          : 'Each one has a reason and a suggested fix in the publishing log.',
        action: 'Open the publishing log',
      };

    case 'SCHEDULE_OVERDUE':
      return {
        ...base,
        title: plural(count, 'post is overdue', 'posts are overdue'),
        detail:
          'These passed their scheduled time and are too late to go out unattended. They are still scheduled — reschedule them or let them go.',
        action: 'Review the schedule',
      };

    case 'APPROVAL_BACKLOG':
      return {
        ...base,
        title: plural(count, 'post is waiting for approval', 'posts are waiting for approval'),
        detail: waited
          ? `The oldest has been waiting ${waited}.`
          : 'Nothing can be scheduled until these are approved.',
        action: 'Open approvals',
      };

    case 'ACCOUNT_DISCONNECTED':
      return {
        ...base,
        title: plural(count, 'account is disconnected', 'accounts are disconnected'),
        detail: `${examples.length > 0 ? `${listNames(examples, count)} ` : ''}Connect again if you still publish to ${count === 1 ? 'it' : 'them'}.`,
        action: 'Manage accounts',
      };

    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled alert kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Order the list the way it should be read.
 *
 * Severity first, then size. Within a severity the bigger problem goes first,
 * because "8 accounts need reconnecting" and "1 account needs reconnecting" are
 * different mornings.
 */
export function rankAlerts(alerts: readonly Alert[]): Alert[] {
  return [...alerts].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count,
  );
}

/** Build, drop the empty ones, and rank. The only entry point the service uses. */
export function collectAlerts(inputs: readonly AlertInput[], now: Date): Alert[] {
  return rankAlerts(
    inputs.filter((input) => input.count > 0).map((input) => buildAlert(input, now)),
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "Acme, Bakery and 4 others" — concrete without becoming a list. */
function listNames(examples: readonly string[], total: number): string {
  const remainder = total - examples.length;
  const named = examples.join(', ');
  if (remainder <= 0) return `${named}.`;
  return `${named} and ${remainder} other${remainder === 1 ? '' : 's'}.`;
}

/**
 * Coarse on purpose.
 *
 * "3 days" is what changes a decision; "3 days, 4 hours and 12 minutes" is
 * precision nobody acts on differently.
 */
export function describeAge(from: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  const hours = Math.floor(ms / 3_600_000);

  if (hours < 1) return 'less than an hour';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
