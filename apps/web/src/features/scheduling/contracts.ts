import { z } from 'zod';
import { POST_STATUSES } from '@orbit/core';

/**
 * Scheduling request schemas (T1.12).
 *
 * As elsewhere, what is absent matters: there is no `status`, no `timezone` on
 * the way in (the workspace's zone decides what a wall time means — assumption
 * C5), and no `publishedAt`. A client says *when*, in local terms; the server
 * decides what instant that is.
 */

const wallTime = z.object({
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
});

export const scheduleSchema = z
  .object({
    /** Wall-clock time in the workspace's zone. */
    localTime: wallTime.optional(),
    /** Take the next configured queue slot instead of naming a time. */
    useNextQueueSlot: z.boolean().optional(),
    /** An explicit UTC instant, for clients that converted it themselves. */
    scheduledForUtc: z.string().datetime().optional(),
  })
  .refine(
    (value) =>
      [value.localTime, value.useNextQueueSlot, value.scheduledForUtc].filter(Boolean).length === 1,
    { message: 'Provide exactly one of localTime, useNextQueueSlot or scheduledForUtc' },
  );

/**
 * Calendar window.
 *
 * `timeZone` here is the *display* zone — which month the viewer means. It does
 * not affect what anything is scheduled for; that is settled and stored in UTC.
 */
export const calendarQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  timeZone: z.string().min(1).max(100),
  workspaceId: z.string().uuid().optional(),
  brandId: z.string().uuid().optional(),
  socialAccountId: z.string().uuid().optional(),
  status: z.enum(POST_STATUSES).optional(),
});

/** Split `YYYY-MM-DD` into the parts the timezone helpers take. */
export function parseCalendarDate(value: string): { year: number; month: number; day: number } {
  const [year, month, day] = value.split('-').map(Number);
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
}

export type ScheduleBody = z.infer<typeof scheduleSchema>;
