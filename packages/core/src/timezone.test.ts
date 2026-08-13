import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors.js';
import {
  assertValidTimeZone,
  formatInZone,
  isValidTimeZone,
  offsetAt,
  parseLocalTime,
  toWallClock,
  zonedDayRange,
  zonedTimeToUtc,
  zonesAgreeAt,
} from './timezone.js';

/**
 * Timezone arithmetic, with **both** DST transitions asserted explicitly
 * (BUILD-PLAN T1.12).
 *
 * The zones are chosen to cover the cases that actually differ:
 *   • `Europe/London` — transitions at 01:00 UTC, offset 0/+1
 *   • `America/New_York` — transitions at 02:00 local, offset −5/−4, and on a
 *     different date from Europe, which is where naive code breaks
 *   • `Asia/Ho_Chi_Minh` — no DST at all, +7 year round (the product's home
 *     zone, and the case that must stay boring)
 *   • `Australia/Sydney` — southern hemisphere, so "spring forward" happens in
 *     October and the sign of the seasonal change is inverted
 */

describe('zone validation', () => {
  it('accepts real IANA zones', () => {
    for (const zone of ['UTC', 'Europe/London', 'Asia/Ho_Chi_Minh', 'America/New_York']) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });

  it('rejects nonsense', () => {
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('GMT+7')).toBe(false);
    expect(() => {
      assertValidTimeZone('Not/AZone');
    }).toThrow(ValidationError);
  });
});

describe('offsets', () => {
  it('reads a fixed-offset zone', () => {
    // Vietnam is +7 always; if this ever moves, something is very wrong.
    const summer = offsetAt(new Date('2026-07-01T00:00:00Z'), 'Asia/Ho_Chi_Minh');
    const winter = offsetAt(new Date('2026-01-01T00:00:00Z'), 'Asia/Ho_Chi_Minh');

    expect(summer).toBe(7 * 3_600_000);
    expect(winter).toBe(7 * 3_600_000);
  });

  it('tracks a DST zone across the year', () => {
    expect(offsetAt(new Date('2026-01-15T12:00:00Z'), 'Europe/London')).toBe(0);
    expect(offsetAt(new Date('2026-07-15T12:00:00Z'), 'Europe/London')).toBe(3_600_000);
  });

  it('tracks the southern hemisphere the other way round', () => {
    // Sydney is +11 in January and +10 in July — the inverse of London.
    expect(offsetAt(new Date('2026-01-15T12:00:00Z'), 'Australia/Sydney')).toBe(11 * 3_600_000);
    expect(offsetAt(new Date('2026-07-15T12:00:00Z'), 'Australia/Sydney')).toBe(10 * 3_600_000);
  });
});

describe('wall clock round trip', () => {
  it('converts a plain time in a plain zone', () => {
    const { instant } = zonedTimeToUtc(
      { year: 2026, month: 3, day: 10, hour: 9, minute: 0 },
      'Asia/Ho_Chi_Minh',
    );

    // 09:00 +07 is 02:00 UTC.
    expect(instant.toISOString()).toBe('2026-03-10T02:00:00.000Z');
  });

  it('round trips through the wall clock unchanged', () => {
    for (const zone of ['UTC', 'Europe/London', 'America/New_York', 'Asia/Ho_Chi_Minh']) {
      const wall = { year: 2026, month: 6, day: 15, hour: 14, minute: 30, second: 0 };
      const { instant } = zonedTimeToUtc(wall, zone);
      expect(toWallClock(instant, zone)).toEqual(wall);
    }
  });

  it('handles a zone whose offset is not a whole hour', () => {
    // India is +05:30. Half-hour offsets are where naive arithmetic shows up.
    const { instant } = zonedTimeToUtc(
      { year: 2026, month: 6, day: 1, hour: 9, minute: 0 },
      'Asia/Kolkata',
    );
    expect(instant.toISOString()).toBe('2026-06-01T03:30:00.000Z');
  });
});

// ── Spring forward: the gap ─────────────────────────────────────────────────

describe('spring forward (the gap)', () => {
  it('rejects a time that does not exist, in Europe', () => {
    // 2026-03-29: London jumps 01:00 → 02:00. 01:30 never happens.
    expect(() =>
      zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, 'Europe/London'),
    ).toThrow(ValidationError);
  });

  it('rejects a time that does not exist, in America', () => {
    // 2026-03-08: New York jumps 02:00 → 03:00. 02:30 never happens — and the
    // date differs from Europe's, which is the case naive code gets wrong.
    expect(() =>
      zonedTimeToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York'),
    ).toThrow(ValidationError);
  });

  it('explains itself in terms a user can act on', () => {
    try {
      zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 1, minute: 30 }, 'Europe/London');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).userMessage).toContain('clocks go forward');
    }
  });

  it('shifts forward when asked to, landing at the first valid instant', () => {
    // What a recurring queue slot needs: still fire, half an hour late, once.
    const result = zonedTimeToUtc(
      { year: 2026, month: 3, day: 29, hour: 1, minute: 30 },
      'Europe/London',
      { nonexistent: 'SHIFT_FORWARD' },
    );

    expect(result.shifted).toBe(true);
    // 01:00 UTC is the transition; 01:30 GMT would have been 01:30 UTC.
    expect(result.instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // Which reads as 02:30 BST — after the gap, as intended.
    expect(toWallClock(result.instant, 'Europe/London').hour).toBe(2);
  });

  it('leaves times either side of the gap alone', () => {
    const before = zonedTimeToUtc(
      { year: 2026, month: 3, day: 29, hour: 0, minute: 30 },
      'Europe/London',
    );
    const after = zonedTimeToUtc(
      { year: 2026, month: 3, day: 29, hour: 3, minute: 30 },
      'Europe/London',
    );

    expect(before.shifted).toBe(false);
    expect(before.instant.toISOString()).toBe('2026-03-29T00:30:00.000Z');
    expect(after.shifted).toBe(false);
    expect(after.instant.toISOString()).toBe('2026-03-29T02:30:00.000Z');
  });

  it('handles the southern hemisphere gap in October', () => {
    // 2026-10-04: Sydney jumps 02:00 → 03:00.
    expect(() =>
      zonedTimeToUtc({ year: 2026, month: 10, day: 4, hour: 2, minute: 30 }, 'Australia/Sydney'),
    ).toThrow(ValidationError);
  });
});

// ── Autumn back: the overlap ────────────────────────────────────────────────

describe('autumn back (the overlap)', () => {
  it('detects a time that happens twice, in Europe', () => {
    // 2026-10-25: London falls 02:00 → 01:00. 01:30 happens twice.
    const result = zonedTimeToUtc(
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30 },
      'Europe/London',
    );

    expect(result.ambiguous).toBe(true);
  });

  it('takes the earlier occurrence by default', () => {
    const result = zonedTimeToUtc(
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30 },
      'Europe/London',
    );

    // Earlier = still BST (+1) = 00:30 UTC. Later would be 01:30 UTC.
    expect(result.instant.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('takes the later occurrence when asked', () => {
    const result = zonedTimeToUtc(
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30 },
      'Europe/London',
      { ambiguous: 'LATER' },
    );

    expect(result.instant.toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });

  it('detects the overlap in America too, on its own date', () => {
    // 2026-11-01: New York falls 02:00 → 01:00.
    const result = zonedTimeToUtc(
      { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
      'America/New_York',
    );

    expect(result.ambiguous).toBe(true);
    // Earlier = still EDT (−4) = 05:30 UTC.
    expect(result.instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('both occurrences really do read as the same wall time', () => {
    // The property that makes it ambiguous in the first place.
    const earlier = zonedTimeToUtc(
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30 },
      'Europe/London',
      { ambiguous: 'EARLIER' },
    ).instant;
    const later = zonedTimeToUtc(
      { year: 2026, month: 10, day: 25, hour: 1, minute: 30 },
      'Europe/London',
      { ambiguous: 'LATER' },
    ).instant;

    expect(later.getTime() - earlier.getTime()).toBe(3_600_000);
    expect(toWallClock(earlier, 'Europe/London')).toEqual(toWallClock(later, 'Europe/London'));
  });

  it('leaves an unambiguous time on the same day alone', () => {
    const result = zonedTimeToUtc(
      { year: 2026, month: 10, day: 25, hour: 9, minute: 0 },
      'Europe/London',
    );

    expect(result.ambiguous).toBe(false);
    expect(result.instant.toISOString()).toBe('2026-10-25T09:00:00.000Z');
  });
});

// ── A zone with no DST must stay boring ─────────────────────────────────────

describe('a zone without DST', () => {
  it('never reports a gap or an overlap, all year', () => {
    for (let month = 1; month <= 12; month += 1) {
      for (const hour of [0, 1, 2, 3, 12, 23]) {
        const result = zonedTimeToUtc(
          { year: 2026, month, day: 15, hour, minute: 30 },
          'Asia/Ho_Chi_Minh',
        );
        expect(result.shifted).toBe(false);
        expect(result.ambiguous).toBe(false);
      }
    }
  });
});

describe('local time parsing', () => {
  it('accepts HH:MM', () => {
    expect(parseLocalTime('09:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseLocalTime('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseLocalTime('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('rejects anything else', () => {
    for (const bad of ['9:30', '09:60', '24:00', '0930', '09:30:00', '']) {
      expect(() => parseLocalTime(bad)).toThrow(ValidationError);
    }
  });
});

describe('zone agreement (assumption C5)', () => {
  it('reports agreement for the same zone', () => {
    expect(zonesAgreeAt(new Date('2026-06-01T12:00:00Z'), 'Europe/London', 'Europe/London')).toBe(
      true,
    );
  });

  it('reports agreement for different zones that happen to match', () => {
    // London and Dublin share an offset year round, so showing both would be
    // noise — C5 says show the second zone only when they differ.
    expect(zonesAgreeAt(new Date('2026-06-01T12:00:00Z'), 'Europe/London', 'Europe/Dublin')).toBe(
      true,
    );
  });

  it('reports disagreement where it matters', () => {
    expect(
      zonesAgreeAt(new Date('2026-06-01T12:00:00Z'), 'Europe/London', 'Asia/Ho_Chi_Minh'),
    ).toBe(false);
  });

  it('notices zones that agree in one season and not another', () => {
    // Phoenix does not observe DST; Los Angeles does. They match in winter only.
    const winter = new Date('2026-01-15T20:00:00Z');
    const summer = new Date('2026-07-15T20:00:00Z');

    expect(zonesAgreeAt(winter, 'America/Phoenix', 'America/Los_Angeles')).toBe(false);
    expect(zonesAgreeAt(summer, 'America/Phoenix', 'America/Los_Angeles')).toBe(true);
  });
});

describe('day ranges', () => {
  it('spans exactly 24 hours on an ordinary day', () => {
    const { start, end } = zonedDayRange({ year: 2026, month: 6, day: 15 }, 'Europe/London');
    expect(end.getTime() - start.getTime()).toBe(24 * 3_600_000);
  });

  it('spans 23 hours on the spring-forward day', () => {
    const { start, end } = zonedDayRange({ year: 2026, month: 3, day: 29 }, 'Europe/London');
    expect(end.getTime() - start.getTime()).toBe(23 * 3_600_000);
  });

  it('spans 25 hours on the autumn-back day', () => {
    const { start, end } = zonedDayRange({ year: 2026, month: 10, day: 25 }, 'Europe/London');
    expect(end.getTime() - start.getTime()).toBe(25 * 3_600_000);
  });

  it('handles a zone where midnight itself is skipped', () => {
    // Some zones spring forward at midnight, so 00:00 does not exist that day.
    // A day range must never throw, whatever the calendar does.
    expect(() => zonedDayRange({ year: 2026, month: 9, day: 6 }, 'America/Santiago')).not.toThrow();
  });

  it('starts at local midnight, not UTC midnight', () => {
    const { start } = zonedDayRange({ year: 2026, month: 6, day: 15 }, 'Asia/Ho_Chi_Minh');
    // Local midnight +07 is 17:00 UTC the day before.
    expect(start.toISOString()).toBe('2026-06-14T17:00:00.000Z');
  });
});

describe('formatting', () => {
  it('renders in the requested zone', () => {
    const instant = new Date('2026-06-15T02:00:00Z');
    expect(
      formatInZone(instant, 'Asia/Ho_Chi_Minh', { timeStyle: 'short', dateStyle: undefined }),
    ).toContain('09:00');
  });
});
