import { describe, expect, it } from 'vitest';
import {
  HUMAN_QUIET_MS,
  autoReplyGate,
  isStaffed,
  readStaffedHours,
  type AutoReplyInput,
} from './auto-reply';

const SAIGON = 'Asia/Ho_Chi_Minh';
// Monday 2026-10-26, 10:00 in Saigon (03:00 UTC).
const mondayTen = new Date('2026-10-26T03:00:00.000Z');
const weekdays = [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '17:00' }));

describe('isStaffed', () => {
  it('is staffed inside a period, in the workspace’s own zone', () => {
    expect(isStaffed(weekdays, SAIGON, mondayTen)).toBe(true);
  });

  /** 18:00 Saigon is 11:00 UTC — inside the period if read in the wrong zone. */
  it('reads the clock in the workspace zone, not UTC', () => {
    expect(isStaffed(weekdays, SAIGON, new Date('2026-10-26T11:00:00.000Z'))).toBe(false);
  });

  it('treats the end as exclusive and weekends as closed', () => {
    expect(isStaffed(weekdays, SAIGON, new Date('2026-10-26T10:00:00.000Z'))).toBe(false);
    expect(isStaffed(weekdays, SAIGON, new Date('2026-10-25T03:00:00.000Z'))).toBe(false);
  });

  /** A broken schedule must not read as "always staffed" — nor as anything. */
  it('staffs nothing for a malformed period', () => {
    expect(isStaffed([{ day: 1, start: '8am', end: '17:00' }], SAIGON, mondayTen)).toBe(false);
  });
});

describe('autoReplyGate', () => {
  const base: AutoReplyInput = {
    mode: 'AUTO',
    windowState: 'OPEN',
    paused: false,
    needsHuman: false,
    repliesSoFar: 0,
    maxReplies: 3,
    lastHumanReplyAt: null,
    lastInboundAt: new Date('2026-10-26T02:58:00.000Z'),
    staffed: false,
    graceMinutes: 10,
    now: mondayTen,
  };

  it('answers out of hours, at once', () => {
    expect(autoReplyGate(base)).toEqual({ act: true });
  });

  it('waits out the grace period during staffed hours, and says until when', () => {
    expect(autoReplyGate({ ...base, staffed: true })).toEqual({
      act: false,
      reason: 'GRACE',
      retryAt: new Date('2026-10-26T03:08:00.000Z'),
    });
    expect(
      autoReplyGate({ ...base, staffed: true, now: new Date('2026-10-26T03:08:00.000Z') }),
    ).toEqual({ act: true });
  });

  /** The Human Agent extension is for a person typing, never the assistant. */
  it('never answers outside the standard window', () => {
    expect(autoReplyGate({ ...base, windowState: 'HUMAN_AGENT' })).toMatchObject({
      reason: 'WINDOW_NOT_OPEN',
    });
    expect(autoReplyGate({ ...base, windowState: 'CLOSED' })).toMatchObject({
      reason: 'WINDOW_NOT_OPEN',
    });
  });

  it('stays out of a conversation a person is in', () => {
    const recently = new Date(mondayTen.getTime() - HUMAN_QUIET_MS + 60_000);
    expect(autoReplyGate({ ...base, lastHumanReplyAt: recently })).toMatchObject({
      reason: 'HUMAN_ACTIVE',
    });
    const longAgo = new Date(mondayTen.getTime() - HUMAN_QUIET_MS - 60_000);
    expect(autoReplyGate({ ...base, lastHumanReplyAt: longAgo })).toEqual({ act: true });
  });

  it('refuses when switched off, paused, escalated or at its reply limit', () => {
    expect(autoReplyGate({ ...base, mode: 'SUGGEST' })).toMatchObject({ reason: 'NOT_AUTO' });
    expect(autoReplyGate({ ...base, mode: 'OFF' })).toMatchObject({ reason: 'NOT_AUTO' });
    expect(autoReplyGate({ ...base, paused: true })).toMatchObject({ reason: 'PAUSED' });
    expect(autoReplyGate({ ...base, needsHuman: true })).toMatchObject({ reason: 'NEEDS_HUMAN' });
    expect(autoReplyGate({ ...base, repliesSoFar: 3 })).toMatchObject({ reason: 'REPLY_LIMIT' });
  });
});

describe('readStaffedHours', () => {
  /** A Json column: whatever is in it is read, never trusted. */
  it('keeps only well-formed periods', () => {
    expect(
      readStaffedHours([
        { day: 1, start: '08:00', end: '17:00' },
        { day: 7, start: '08:00', end: '17:00' },
        { day: 2, start: 8 },
        'monday',
        null,
      ]),
    ).toEqual([{ day: 1, start: '08:00', end: '17:00' }]);
    expect(readStaffedHours({ day: 1 })).toEqual([]);
    expect(readStaffedHours(null)).toEqual([]);
  });
});
