import { describe, expect, it } from 'vitest';
import {
  ALERT_KINDS,
  ALERT_SEVERITY,
  buildAlert,
  collectAlerts,
  describeAge,
  rankAlerts,
  type Alert,
} from './alerts';

/**
 * The wording and ranking of the dashboard (SRS §20, T1.17).
 *
 * Worth unit tests because the dashboard's value is entirely in what it makes
 * somebody do next. An alert that is ranked wrong sends the agency to the small
 * problem first; an alert whose sentence is wrong sends them nowhere.
 */

const NOW = new Date('2026-06-15T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('every alert kind', () => {
  it('produces a title, a detail and an action', () => {
    for (const kind of ALERT_KINDS) {
      const alert = buildAlert({ kind, count: 3 }, NOW);

      expect(alert.title, kind).toBeTruthy();
      expect(alert.detail, kind).toBeTruthy();
      expect(alert.action, kind).toBeTruthy();
      expect(alert.title, kind).not.toContain('undefined');
      expect(alert.detail, kind).not.toContain('undefined');
    }
  });

  it('has a severity', () => {
    for (const kind of ALERT_KINDS) {
      expect(ALERT_SEVERITY[kind], kind).toBeTruthy();
    }
  });

  it('counts singular and plural correctly', () => {
    for (const kind of ALERT_KINDS) {
      expect(buildAlert({ kind, count: 1 }, NOW).title, kind).toMatch(/^1 /);
      expect(buildAlert({ kind, count: 2 }, NOW).title, kind).toMatch(/^2 /);
    }

    expect(buildAlert({ kind: 'PUBLISH_FAILED', count: 1 }, NOW).title).toContain('post failed');
    expect(buildAlert({ kind: 'PUBLISH_FAILED', count: 2 }, NOW).title).toContain('posts failed');
  });
});

describe('severity', () => {
  it('treats a broken connection and a parked publish as blocking', () => {
    // The two conditions where nothing moves until a person acts.
    expect(ALERT_SEVERITY.ACCOUNT_NEEDS_RECONNECT).toBe('CRITICAL');
    expect(ALERT_SEVERITY.PUBLISH_NEEDS_REVIEW).toBe('CRITICAL');
  });

  it('does not treat a deliberate disconnection as a problem', () => {
    expect(ALERT_SEVERITY.ACCOUNT_DISCONNECTED).toBe('INFO');
  });
});

describe('ranking', () => {
  it('puts blocking problems first, then the biggest', () => {
    const alerts = collectAlerts(
      [
        { kind: 'PUBLISH_FAILED', count: 9 },
        { kind: 'ACCOUNT_NEEDS_RECONNECT', count: 1 },
        { kind: 'ACCOUNT_DISCONNECTED', count: 20 },
        { kind: 'PUBLISH_NEEDS_REVIEW', count: 2 },
      ],
      NOW,
    );

    expect(alerts.map((a) => a.kind)).toEqual([
      // Both critical; the bigger one first.
      'PUBLISH_NEEDS_REVIEW',
      'ACCOUNT_NEEDS_RECONNECT',
      'PUBLISH_FAILED',
      'ACCOUNT_DISCONNECTED',
    ]);
  });

  it('drops the empty ones', () => {
    const alerts = collectAlerts(
      [
        { kind: 'PUBLISH_FAILED', count: 0 },
        { kind: 'APPROVAL_BACKLOG', count: 2 },
      ],
      NOW,
    );

    expect(alerts.map((a) => a.kind)).toEqual(['APPROVAL_BACKLOG']);
  });

  it('returns nothing at all when everything is fine', () => {
    expect(
      collectAlerts(
        ALERT_KINDS.map((kind) => ({ kind, count: 0 })),
        NOW,
      ),
    ).toEqual([]);
  });

  it('does not mutate its input', () => {
    const alerts: Alert[] = collectAlerts(
      [
        { kind: 'ACCOUNT_DISCONNECTED', count: 1 },
        { kind: 'PUBLISH_NEEDS_REVIEW', count: 1 },
      ],
      NOW,
    );

    const before = [...alerts];
    rankAlerts(alerts);
    expect(alerts).toEqual(before);
  });
});

describe('naming names', () => {
  it('quotes a few accounts and counts the rest', () => {
    const alert = buildAlert(
      {
        kind: 'ACCOUNT_NEEDS_RECONNECT',
        count: 6,
        examples: ['Acme Bakery', 'Bell Books', 'Cobb Coffee'],
      },
      NOW,
    );

    expect(alert.detail).toContain('Acme Bakery, Bell Books, Cobb Coffee and 3 others.');
  });

  it('does not say "and 0 others"', () => {
    const alert = buildAlert(
      { kind: 'ACCOUNT_NEEDS_RECONNECT', count: 2, examples: ['Acme Bakery', 'Bell Books'] },
      NOW,
    );

    expect(alert.detail).toContain('Acme Bakery, Bell Books.');
    expect(alert.detail).not.toContain('others');
  });

  it('never quotes more than three, however many it is given', () => {
    const alert = buildAlert(
      { kind: 'ACCOUNT_NEEDS_RECONNECT', count: 5, examples: ['a', 'b', 'c', 'd', 'e'] },
      NOW,
    );

    expect(alert.examples).toHaveLength(3);
  });
});

describe('a parked publish is not described as a failure', () => {
  it('says the outcome is unknown, because it is', () => {
    // Decision D-027: the system stopped precisely because it could not tell.
    // An alert that says "failed" would assert what everything else refuses to.
    const alert = buildAlert({ kind: 'PUBLISH_NEEDS_REVIEW', count: 2 }, NOW);

    expect(alert.detail).toContain('could not confirm');
    expect(alert.detail.toLowerCase()).not.toContain('failed');
  });
});

describe('describeAge', () => {
  it('rounds to something a person would say', () => {
    expect(describeAge(hoursAgo(0.5), NOW)).toBe('less than an hour');
    expect(describeAge(hoursAgo(1), NOW)).toBe('1 hour');
    expect(describeAge(hoursAgo(5), NOW)).toBe('5 hours');
    expect(describeAge(hoursAgo(24), NOW)).toBe('1 day');
    expect(describeAge(hoursAgo(72), NOW)).toBe('3 days');
  });

  it('never reports a negative age for a clock skew', () => {
    expect(describeAge(new Date(NOW.getTime() + 60_000), NOW)).toBe('less than an hour');
  });

  it('is used in the backlog alert', () => {
    const alert = buildAlert({ kind: 'APPROVAL_BACKLOG', count: 4, oldestAt: hoursAgo(50) }, NOW);
    expect(alert.detail).toContain('2 days');
  });
});
