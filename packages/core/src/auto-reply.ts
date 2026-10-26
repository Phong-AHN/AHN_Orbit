import { parseLocalTime, toWallClock } from './timezone.js';

/**
 * When the AI assistant may answer a private message on its own (**D-108**).
 *
 * Pure, because this is the rule that decides whether something reaches a
 * client's customer with no person in the loop. It is asked twice — when a
 * message arrives, to decide whether to schedule a reply at all, and again just
 * before sending, because a colleague may have answered in the meantime — and
 * both ask the same function.
 *
 * Every condition fails closed. The assistant answers only when *all* of them
 * hold; any one of them failing means a person handles it.
 */

/** One staffed period on one weekday, in the workspace's own time zone. */
export interface StaffedPeriod {
  /** 0 = Sunday … 6 = Saturday, as `Date#getUTCDay` counts. */
  day: number;
  /** `HH:MM`, inclusive. */
  start: string;
  /** `HH:MM`, exclusive. */
  end: string;
}

/**
 * The stored schedule, read defensively: it is a Json column, so anything that
 * is not a period is dropped rather than trusted.
 */
export function readStaffedHours(value: unknown): StaffedPeriod[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is StaffedPeriod =>
      typeof entry === 'object' &&
      entry !== null &&
      Number.isInteger((entry as StaffedPeriod).day) &&
      (entry as StaffedPeriod).day >= 0 &&
      (entry as StaffedPeriod).day <= 6 &&
      typeof (entry as StaffedPeriod).start === 'string' &&
      typeof (entry as StaffedPeriod).end === 'string',
  );
}

/** Whether somebody is expected to be answering at `now`. */
export function isStaffed(hours: readonly StaffedPeriod[], timeZone: string, now: Date): boolean {
  const wall = toWallClock(now, timeZone);
  const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  const minute = wall.hour * 60 + wall.minute;

  return hours.some((period) => {
    if (period.day !== weekday) return false;
    try {
      const start = parseLocalTime(period.start);
      const end = parseLocalTime(period.end);
      return minute >= start.hour * 60 + start.minute && minute < end.hour * 60 + end.minute;
    } catch {
      // A malformed period staffs nothing rather than everything: the safe
      // reading of a broken schedule is "nobody said they would be here".
      return false;
    }
  });
}

export type AutoReplyMode = 'OFF' | 'SUGGEST' | 'AUTO';

export type AutoReplyRefusal =
  | 'NOT_AUTO'
  | 'WINDOW_NOT_OPEN'
  | 'PAUSED'
  | 'NEEDS_HUMAN'
  | 'REPLY_LIMIT'
  | 'HUMAN_ACTIVE'
  | 'GRACE';

export type AutoReplyGate =
  { act: true } | { act: false; reason: AutoReplyRefusal; retryAt?: Date | undefined };

/**
 * How long after a person has answered the assistant stays out of the
 * conversation. Long enough to cover a colleague coming back to a thread they
 * started; a conversation nobody has touched in that long is fair game again.
 */
export const HUMAN_QUIET_MS = 12 * 60 * 60 * 1_000;

export interface AutoReplyInput {
  mode: AutoReplyMode;
  /**
   * The standard reply window, from `replyWindow`. Only `OPEN` will do: the
   * Human Agent extension is for a reply a person typed, by Meta's policy and
   * by ours, and the assistant never uses it.
   */
  windowState: 'OPEN' | 'HUMAN_AGENT' | 'CLOSED';
  /** The customer asked the assistant to stop, or a colleague switched it off here. */
  paused: boolean;
  /** Already handed to a person and not yet dealt with. */
  needsHuman: boolean;
  repliesSoFar: number;
  maxReplies: number;
  /** The latest message a person sent in this conversation, from Orbit or the platform's app. */
  lastHumanReplyAt: Date | null;
  /** The customer's latest message. */
  lastInboundAt: Date;
  staffed: boolean;
  graceMinutes: number;
  now: Date;
}

/**
 * Whether the assistant may answer now.
 *
 * During staffed hours it waits `graceMinutes` after the customer's latest
 * message, so a colleague who is there gets to answer first; outside them it
 * answers at once. When the only obstacle is that grace period, the refusal
 * carries when to ask again.
 */
export function autoReplyGate(input: AutoReplyInput): AutoReplyGate {
  if (input.mode !== 'AUTO') return { act: false, reason: 'NOT_AUTO' };
  if (input.windowState !== 'OPEN') return { act: false, reason: 'WINDOW_NOT_OPEN' };
  if (input.paused) return { act: false, reason: 'PAUSED' };
  if (input.needsHuman) return { act: false, reason: 'NEEDS_HUMAN' };
  if (input.repliesSoFar >= input.maxReplies) return { act: false, reason: 'REPLY_LIMIT' };

  if (
    input.lastHumanReplyAt &&
    input.now.getTime() - input.lastHumanReplyAt.getTime() < HUMAN_QUIET_MS
  ) {
    return { act: false, reason: 'HUMAN_ACTIVE' };
  }

  if (input.staffed) {
    const ready = new Date(input.lastInboundAt.getTime() + input.graceMinutes * 60_000);
    if (input.now < ready) return { act: false, reason: 'GRACE', retryAt: ready };
  }

  return { act: true };
}
