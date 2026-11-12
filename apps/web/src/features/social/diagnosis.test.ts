import { describe, expect, it } from 'vitest';
import { diagnose, readDegradedRecord } from './diagnosis';

const formatWhen = (value: Date) => value.toISOString().slice(0, 16);
const DAY = 24 * 60 * 60 * 1000;
const connectedAt = new Date('2026-11-01T09:00:00Z');

describe('readDegradedRecord', () => {
  it('reads what the worker writes, and ignores what it does not know', () => {
    expect(
      readDegradedRecord({
        createdAt: connectedAt,
        actorType: 'WORKER',
        after: {
          status: 'NEEDS_RECONNECT',
          source: 'health-probe',
          reason: 'r',
          workerCommit: 'abc1234',
          x: 1,
        },
      }),
    ).toEqual({
      at: connectedAt,
      actorType: 'WORKER',
      source: 'health-probe',
      reason: 'r',
      workerCommit: 'abc1234',
    });
    expect(readDegradedRecord({ createdAt: connectedAt, actorType: 'USER', after: null })).toEqual({
      at: connectedAt,
      actorType: 'USER',
    });
  });
});

describe('diagnose', () => {
  it('says what marked it, and which worker build', () => {
    const { trail } = diagnose({
      platform: 'FACEBOOK',
      connectedAt,
      formatWhen,
      degraded: {
        at: connectedAt,
        actorType: 'WORKER',
        source: 'health-probe',
        workerCommit: 'abc1234',
      },
    });
    expect(trail).toBe(
      'Marked 2026-11-01T09:00 by the hourly connection check (worker build abc1234).',
    );
  });

  /** A worker that records no build is older than the fix, and still running. */
  it('names an old worker when the record carries no build', () => {
    const { trail } = diagnose({
      platform: 'YOUTUBE',
      connectedAt,
      formatWhen,
      degraded: { at: new Date(connectedAt.getTime() + DAY), actorType: 'WORKER' },
    });
    expect(trail).toMatch(/older than 6 Nov is still running/);
  });

  it('does not blame a worker for a check run from the web', () => {
    const { trail } = diagnose({
      platform: 'YOUTUBE',
      connectedAt,
      formatWhen,
      degraded: { at: connectedAt, actorType: 'USER', source: 'manual-check' },
    });
    expect(trail).toBe('Marked 2026-11-01T09:00 by a check run from this page.');
  });

  it('points at Testing mode when a YouTube channel drops seven days after connecting', () => {
    const at = new Date(connectedAt.getTime() + 7 * DAY + 2 * 60 * 60 * 1000);
    const { likelyCause } = diagnose({
      platform: 'YOUTUBE',
      connectedAt,
      formatWhen,
      degraded: { at, actorType: 'WORKER', workerCommit: 'abc1234' },
    });
    expect(likelyCause).toMatch(/Testing mode/);
  });

  it('suggests nothing when the timing does not point anywhere', () => {
    for (const [platform, days] of [
      ['YOUTUBE', 2],
      ['YOUTUBE', 9],
      ['FACEBOOK', 7],
    ] as const) {
      const at = new Date(connectedAt.getTime() + days * DAY);
      expect(
        diagnose({ platform, connectedAt, formatWhen, degraded: { at, actorType: 'WORKER' } })
          .likelyCause,
      ).toBeUndefined();
    }
  });
});
