import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors.js';
import {
  MAX_LEAD_MS,
  MIN_LEAD_MS,
  SCHEDULE_TOLERANCE_MS,
  STALE_SCHEDULE_MS,
  assertSchedulable,
  earliestSlot,
  isDue,
  isStale,
  nextQueueSlot,
  publishIdempotencyKey,
  resolveSchedule,
} from './scheduling.js';
import { toWallClock } from './timezone.js';

const NOW = new Date('2026-06-15T12:00:00Z');

describe('resolveSchedule', () => {
  it('stores UTC for a workspace-zone intent', () => {
    const resolved = resolveSchedule({
      localTime: { year: 2026, month: 7, day: 1, hour: 9, minute: 0 },
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    expect(resolved.scheduledFor.toISOString()).toBe('2026-07-01T02:00:00.000Z');
    expect(resolved.timeZone).toBe('Asia/Ho_Chi_Minh');
  });

  it('rejects a time in a spring-forward gap by default', () => {
    // A person picked this; they should be told, not silently moved.
    expect(() =>
      resolveSchedule({
        localTime: { year: 2026, month: 3, day: 29, hour: 1, minute: 30 },
        timeZone: 'Europe/London',
      }),
    ).toThrow(ValidationError);
  });

  it('reports an ambiguous time rather than hiding it', () => {
    const resolved = resolveSchedule({
      localTime: { year: 2026, month: 10, day: 25, hour: 1, minute: 30 },
      timeZone: 'Europe/London',
    });

    expect(resolved.ambiguous).toBe(true);
    // Earlier by default: publishing early beats publishing late.
    expect(resolved.scheduledFor.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('keeps the zone so a later reschedule reasons in the same terms', () => {
    const resolved = resolveSchedule({
      localTime: { year: 2026, month: 7, day: 1, hour: 9, minute: 0 },
      timeZone: 'America/New_York',
    });
    expect(resolved.timeZone).toBe('America/New_York');
  });
});

describe('assertSchedulable', () => {
  it('accepts a sensible future time', () => {
    expect(() => {
      assertSchedulable(new Date(NOW.getTime() + 3_600_000), NOW);
    }).not.toThrow();
  });

  it('rejects the past', () => {
    expect(() => {
      assertSchedulable(new Date(NOW.getTime() - 1_000), NOW);
    }).toThrow(ValidationError);
  });

  it('rejects a lead time short enough to race the sweep', () => {
    // A variant scheduled seconds out could be swept before the transaction
    // that scheduled it commits.
    expect(() => {
      assertSchedulable(new Date(NOW.getTime() + MIN_LEAD_MS - 1), NOW);
    }).toThrow(ValidationError);

    expect(() => {
      assertSchedulable(new Date(NOW.getTime() + MIN_LEAD_MS + 1), NOW);
    }).not.toThrow();
  });

  it('rejects a date more than a year out as a likely typo', () => {
    expect(() => {
      assertSchedulable(new Date(NOW.getTime() + MAX_LEAD_MS + 86_400_000), NOW);
    }).toThrow(ValidationError);
  });

  it('rejects an invalid date', () => {
    expect(() => {
      assertSchedulable(new Date('not a date'), NOW);
    }).toThrow(ValidationError);
  });

  it('says something a user can act on', () => {
    try {
      assertSchedulable(new Date(NOW.getTime() - 60_000), NOW);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ValidationError).userMessage).toContain('already passed');
    }
  });
});

describe('due and stale windows (assumption C10)', () => {
  it('treats a variant within tolerance as due', () => {
    // The sweep runs every 30s; tolerance is what makes a slightly late sweep
    // still on time.
    expect(isDue(new Date(NOW.getTime() + SCHEDULE_TOLERANCE_MS - 1), NOW)).toBe(true);
    expect(isDue(new Date(NOW.getTime() + SCHEDULE_TOLERANCE_MS + 1_000), NOW)).toBe(false);
  });

  it('treats an overdue variant as due', () => {
    expect(isDue(new Date(NOW.getTime() - 600_000), NOW)).toBe(true);
  });

  it('treats a long-overdue variant as stale rather than due', () => {
    // Publishing a "good morning" at 4pm because workers were down is worse
    // than not publishing it.
    const longAgo = new Date(NOW.getTime() - STALE_SCHEDULE_MS - 60_000);

    expect(isDue(longAgo, NOW)).toBe(true);
    expect(isStale(longAgo, NOW)).toBe(true);
  });

  it('does not call a merely late variant stale', () => {
    expect(isStale(new Date(NOW.getTime() - 60_000), NOW)).toBe(false);
  });
});

describe('publishIdempotencyKey', () => {
  const base = {
    postVariantId: '018f0000-0000-7000-8000-000000000001',
    scheduledFor: new Date('2026-07-01T09:00:00Z'),
    contentHash: 'abc123',
  };

  it('is stable for the same intent', () => {
    expect(publishIdempotencyKey(base)).toBe(publishIdempotencyKey(base));
  });

  it('changes when the post is rescheduled', () => {
    // A reschedule is a genuinely different publish, so it must not collapse
    // onto the old job.
    const moved = { ...base, scheduledFor: new Date('2026-07-01T10:00:00Z') };
    expect(publishIdempotencyKey(moved)).not.toBe(publishIdempotencyKey(base));
  });

  it('changes when the content changes', () => {
    expect(publishIdempotencyKey({ ...base, contentHash: 'def456' })).not.toBe(
      publishIdempotencyKey(base),
    );
  });

  it('differs per variant', () => {
    expect(
      publishIdempotencyKey({ ...base, postVariantId: '018f0000-0000-7000-8000-000000000002' }),
    ).not.toBe(publishIdempotencyKey(base));
  });

  it('carries the variant id so a key is traceable in logs', () => {
    expect(publishIdempotencyKey(base)).toContain(base.postVariantId);
  });

  it('stays inside the payload schema length limit', () => {
    expect(publishIdempotencyKey(base).length).toBeLessThanOrEqual(200);
  });
});

describe('nextQueueSlot', () => {
  it('finds the next occurrence of a weekday slot', () => {
    // 2026-06-15 is a Monday. The next Wednesday (3) at 09:00 Saigon.
    const next = nextQueueSlot(
      { dayOfWeek: 3, localTime: '09:00', timeZone: 'Asia/Ho_Chi_Minh' },
      NOW,
    );

    expect(toWallClock(next, 'Asia/Ho_Chi_Minh')).toMatchObject({
      year: 2026,
      month: 6,
      day: 17,
      hour: 9,
      minute: 0,
    });
  });

  it('rolls to next week when today slot has passed', () => {
    // Monday 12:00 UTC = 19:00 Saigon, so Monday 09:00 is already gone.
    const next = nextQueueSlot(
      { dayOfWeek: 1, localTime: '09:00', timeZone: 'Asia/Ho_Chi_Minh' },
      NOW,
    );

    expect(toWallClock(next, 'Asia/Ho_Chi_Minh').day).toBe(22);
  });

  it('takes today when the slot is still ahead', () => {
    const next = nextQueueSlot(
      { dayOfWeek: 1, localTime: '23:00', timeZone: 'Asia/Ho_Chi_Minh' },
      NOW,
    );

    expect(toWallClock(next, 'Asia/Ho_Chi_Minh').day).toBe(15);
  });

  it('resolves the weekday in the slot own zone, not UTC', () => {
    // 2026-06-15T23:30Z is still Monday in UTC but already Tuesday in Saigon.
    const late = new Date('2026-06-15T23:30:00Z');
    const next = nextQueueSlot(
      { dayOfWeek: 2, localTime: '09:00', timeZone: 'Asia/Ho_Chi_Minh' },
      late,
    );

    // Tuesday the 16th, Saigon — not a week later.
    expect(toWallClock(next, 'Asia/Ho_Chi_Minh')).toMatchObject({ day: 16, hour: 9 });
  });

  it('still fires on a spring-forward day rather than skipping the week', () => {
    // 2026-03-29 is a Sunday, and London skips 01:00–02:00. A weekly 01:30
    // slot must not silently vanish twice a year (decision D-023).
    const before = new Date('2026-03-27T12:00:00Z');
    const next = nextQueueSlot(
      { dayOfWeek: 0, localTime: '01:30', timeZone: 'Europe/London' },
      before,
    );

    expect(next.toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // Which reads as 02:30 local — shifted past the gap, same day.
    expect(toWallClock(next, 'Europe/London')).toMatchObject({ day: 29, hour: 2, minute: 30 });
  });

  it('picks the earlier occurrence on an autumn-back day', () => {
    const before = new Date('2026-10-23T12:00:00Z');
    const next = nextQueueSlot(
      { dayOfWeek: 0, localTime: '01:30', timeZone: 'Europe/London' },
      before,
    );

    expect(next.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('always returns a time strictly in the future', () => {
    // Exactly on the slot must roll forward, not return `after` itself.
    const exactly = nextQueueSlot(
      { dayOfWeek: 1, localTime: '19:00', timeZone: 'Asia/Ho_Chi_Minh' },
      NOW,
    );
    expect(exactly.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('rejects an out-of-range weekday', () => {
    for (const dayOfWeek of [-1, 7, 1.5]) {
      expect(() => nextQueueSlot({ dayOfWeek, localTime: '09:00', timeZone: 'UTC' }, NOW)).toThrow(
        ValidationError,
      );
    }
  });

  it('rejects a malformed time', () => {
    expect(() => nextQueueSlot({ dayOfWeek: 1, localTime: '9am', timeZone: 'UTC' }, NOW)).toThrow(
      ValidationError,
    );
  });
});

describe('earliestSlot', () => {
  it('picks the soonest of several', () => {
    const slots = [
      { dayOfWeek: 5, localTime: '09:00', timeZone: 'Asia/Ho_Chi_Minh' },
      { dayOfWeek: 2, localTime: '09:00', timeZone: 'Asia/Ho_Chi_Minh' },
      { dayOfWeek: 4, localTime: '09:00', timeZone: 'Asia/Ho_Chi_Minh' },
    ];

    // Tuesday the 16th is soonest from Monday.
    expect(toWallClock(earliestSlot(slots, NOW), 'Asia/Ho_Chi_Minh').day).toBe(16);
  });

  it('compares across zones correctly', () => {
    const slots = [
      { dayOfWeek: 2, localTime: '09:00', timeZone: 'Asia/Ho_Chi_Minh' },
      { dayOfWeek: 2, localTime: '09:00', timeZone: 'America/New_York' },
    ];

    // Same wall time, but Saigon reaches it 11 hours earlier.
    expect(earliestSlot(slots, NOW).toISOString()).toBe('2026-06-16T02:00:00.000Z');
  });

  it('refuses when no slots are configured', () => {
    expect(() => earliestSlot([], NOW)).toThrow(ValidationError);
  });
});
