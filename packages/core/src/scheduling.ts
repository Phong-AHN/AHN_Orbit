import { createHash } from 'node:crypto';
import { ValidationError } from './errors.js';
import { clock } from './clock.js';
import {
  parseLocalTime,
  zonedTimeToUtc,
  toWallClock,
  type AmbiguousTimePolicy,
  type NonexistentTimePolicy,
} from './timezone.js';

/**
 * Scheduling rules (SRS §12, §13; assumptions C5 and C10).
 *
 * Pure domain logic — no database, no queue, no provider. The two things it
 * owns:
 *
 *   1. turning an intent ("9am Tuesday in the workspace's zone") into the UTC
 *      instant that is actually stored;
 *   2. deriving the idempotency key that stops one intent becoming two posts.
 */

/**
 * How late a sweep may be and still publish (assumption C10).
 *
 * The sweep runs every 30s, so a due variant is picked up within 30s in the
 * normal case. The tolerance is what defines "still on time" when a worker
 * restart or a slow sweep delays it.
 */
export const SCHEDULE_TOLERANCE_MS = 60_000;

/**
 * How far past its time a variant may be published without a human looking.
 *
 * Beyond this the post is stale rather than late — publishing a "good morning"
 * at 4pm because the workers were down for six hours is worse than not
 * publishing it. Such variants are surfaced instead (T1.14).
 */
export const STALE_SCHEDULE_MS = 2 * 60 * 60 * 1_000;

/** The shortest notice a schedule may be given. Stops "schedule for now" races. */
export const MIN_LEAD_MS = 60_000;

/** A year out. Beyond this it is almost always a typo'd year. */
export const MAX_LEAD_MS = 365 * 24 * 60 * 60 * 1_000;

export interface ScheduleIntent {
  /** Wall-clock time the user chose, in `timeZone`. */
  localTime: { year: number; month: number; day: number; hour: number; minute: number };
  /** The workspace's zone — scheduling semantics resolve here (C5). */
  timeZone: string;
  nonexistent?: NonexistentTimePolicy;
  ambiguous?: AmbiguousTimePolicy;
}

export interface ResolvedSchedule {
  /** What gets stored. Always UTC. */
  scheduledFor: Date;
  /** Recorded alongside, so a later reschedule can reason in the same zone. */
  timeZone: string;
  /** The requested time did not exist and was moved to the next valid instant. */
  shifted: boolean;
  /** The requested time occurred twice; the earlier was taken by default. */
  ambiguous: boolean;
}

/**
 * Resolve a scheduling intent to the instant to store.
 *
 * Defaults to `REJECT` for a nonexistent time: a person who picked 02:30 on a
 * spring-forward day should be told it does not exist, not silently moved.
 * Recurring queue slots pass `SHIFT_FORWARD` instead — see `resolveQueueSlot`.
 */
export function resolveSchedule(intent: ScheduleIntent): ResolvedSchedule {
  const conversion = zonedTimeToUtc(intent.localTime, intent.timeZone, {
    nonexistent: intent.nonexistent ?? 'REJECT',
    ambiguous: intent.ambiguous ?? 'EARLIER',
  });

  return {
    scheduledFor: conversion.instant,
    timeZone: intent.timeZone,
    shifted: conversion.shifted,
    ambiguous: conversion.ambiguous,
  };
}

/**
 * Reject a schedule that is too soon, in the past, or implausibly far out.
 *
 * `MIN_LEAD_MS` is what stops "schedule for right now" racing the sweep: a
 * variant scheduled 5 seconds out could be swept before the transaction that
 * scheduled it commits, and the sweep would not see it as `SCHEDULED` yet.
 */
export function assertSchedulable(scheduledFor: Date, now: Date = clock.now()): void {
  const lead = scheduledFor.getTime() - now.getTime();

  if (Number.isNaN(scheduledFor.getTime())) {
    throw new ValidationError('Invalid schedule time', {
      userMessage: "That date doesn't look right.",
      details: [{ field: 'scheduledFor', issue: 'not a valid date' }],
    });
  }

  if (lead < MIN_LEAD_MS) {
    throw new ValidationError('Schedule time is in the past or too soon', {
      userMessage:
        lead < 0
          ? 'That time has already passed. Pick a time in the future.'
          : 'Schedule at least a minute ahead, or publish now instead.',
      details: [{ field: 'scheduledFor', issue: 'must be at least 60 seconds in the future' }],
      context: { leadMs: lead },
    });
  }

  if (lead > MAX_LEAD_MS) {
    throw new ValidationError('Schedule time is too far in the future', {
      userMessage: "That's more than a year away — check the year.",
      details: [{ field: 'scheduledFor', issue: 'must be within a year' }],
      context: { leadMs: lead },
    });
  }
}

/** Is this variant due to be swept? */
export function isDue(
  scheduledFor: Date,
  now: Date = clock.now(),
  toleranceMs: number = SCHEDULE_TOLERANCE_MS,
): boolean {
  return scheduledFor.getTime() <= now.getTime() + toleranceMs;
}

/** Too late to publish unattended. */
export function isStale(
  scheduledFor: Date,
  now: Date = clock.now(),
  staleAfterMs: number = STALE_SCHEDULE_MS,
): boolean {
  return now.getTime() - scheduledFor.getTime() > staleAfterMs;
}

/**
 * Idempotency layer 1 (docs/ARCHITECTURE.md §5.2).
 *
 * Derived from the variant, the exact instant it is scheduled for, and the
 * content hash — so the same intent always produces the same key, and BullMQ
 * drops the duplicate add. Two schedulers racing on the same sweep therefore
 * enqueue one job, not two.
 *
 * Changing *any* of the three is meant to produce a new key: rescheduling is a
 * genuinely different publish, and edited content is a different post. That is
 * why the schedule time is in the key rather than just the variant id.
 */
export function publishIdempotencyKey(input: {
  postVariantId: string;
  scheduledFor: Date;
  contentHash: string;
}): string {
  const digest = createHash('sha256')
    .update(
      [input.postVariantId, String(input.scheduledFor.getTime()), input.contentHash].join('|'),
      'utf8',
    )
    .digest('hex')
    .slice(0, 32);

  return `publish:${input.postVariantId}:${digest}`;
}

export interface QueueSlotIntent {
  /** 0 = Sunday, matching `Date.getUTCDay` and `QueueSlot.dayOfWeek`. */
  dayOfWeek: number;
  /** `"HH:MM"` in `timeZone`. */
  localTime: string;
  timeZone: string;
}

/**
 * The next occurrence of a recurring slot, strictly after `after`.
 *
 * Uses `SHIFT_FORWARD`: a weekly 02:30 slot must still resolve on the Sunday
 * the clocks go forward. Rejecting would silently drop one week's post twice a
 * year, which is worse than publishing half an hour later that once (D-023).
 */
export function nextQueueSlot(intent: QueueSlotIntent, after: Date = clock.now()): Date {
  const { hour, minute } = parseLocalTime(intent.localTime);

  if (!Number.isInteger(intent.dayOfWeek) || intent.dayOfWeek < 0 || intent.dayOfWeek > 6) {
    throw new ValidationError(`Invalid day of week: ${intent.dayOfWeek}`, {
      userMessage: 'Pick a day of the week.',
      details: [{ field: 'dayOfWeek', issue: 'must be 0 (Sunday) through 6 (Saturday)' }],
    });
  }

  // Walk forward from the day `after` falls on *in the slot's zone*, so a slot
  // at 09:00 Monday means Monday there, not Monday in UTC.
  const startWall = toWallClock(after, intent.timeZone);

  for (let offset = 0; offset <= 8; offset += 1) {
    const day = new Date(Date.UTC(startWall.year, startWall.month - 1, startWall.day + offset, 12));
    if (day.getUTCDay() !== intent.dayOfWeek) continue;

    const candidate = zonedTimeToUtc(
      {
        year: day.getUTCFullYear(),
        month: day.getUTCMonth() + 1,
        day: day.getUTCDate(),
        hour,
        minute,
      },
      intent.timeZone,
      { nonexistent: 'SHIFT_FORWARD', ambiguous: 'EARLIER' },
    ).instant;

    if (candidate.getTime() > after.getTime()) return candidate;
  }

  // Unreachable: eight days always contain the weekday twice.
  throw new ValidationError('Could not resolve the next queue slot', {
    userMessage: "We couldn't work out when that slot next comes round.",
    context: { intent },
  });
}

/** The earliest of several slots. Used by "next available slot" scheduling. */
export function earliestSlot(slots: readonly QueueSlotIntent[], after: Date = clock.now()): Date {
  if (slots.length === 0) {
    throw new ValidationError('No queue slots configured', {
      userMessage: 'This workspace has no posting times set up yet.',
      details: [{ field: 'queueSlots', issue: 'none configured' }],
    });
  }

  return slots
    .map((slot) => nextQueueSlot(slot, after))
    .reduce((earliest, current) => (current < earliest ? current : earliest));
}
