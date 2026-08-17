import type { PostStatus } from '@orbit/core';
import { ApiError } from '@/features/posts/ui/api';

export { STATUS_LABEL, STATUS_TONE } from '@/features/posts/ui/status';

/**
 * What the month, week and list views all agree on (SRS §7).
 *
 * Extracted when the week view arrived, and worth extracting rather than
 * copying: **two calendars with two implementations of "which day is this in
 * the client's zone" is two answers to the same question**, and the one that
 * drifts is the one nobody is looking at. A schedule shown on the wrong day is
 * a client's post going out when they were told it would not.
 */

export interface CalendarPost {
  id: string;
  title: string | null;
  body: string;
  status: PostStatus;
  scheduledFor: string | null;
  /** The zone the schedule was expressed in — the workspace's, not the viewer's. */
  timezone: string | null;
  variants: Array<{ id: string; platform: string; status: string; accountName: string }>;
}

export function timeIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

export function weekdayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(date);
}

/**
 * The wall-clock parts of an instant, in a named zone.
 *
 * `formatToParts` rather than arithmetic: offsets are not constant, and a zone
 * that shifts by 30 or 45 minutes — or by an hour on one Sunday in the year —
 * is exactly where hand-rolled conversion produces a post an hour late.
 */
export function wallPartsIn(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

export function dayKeyIn(date: Date, timeZone: string): string {
  const parts = wallPartsIn(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Move a post, through the scheduling API.
 *
 * The one path a drag can take, in either view. The UI **never** computes a UTC
 * instant and sends it: it sends wall-clock parts, and the server resolves them
 * in the workspace's own zone — which is the only place that knows whether that
 * wall time exists on that date, and what to do on the Sunday it does not.
 */
export async function reschedulePost(
  orgSlug: string,
  postId: string,
  localTime: LocalTime,
): Promise<{ scheduledFor: string }> {
  const response = await fetch(
    `/api/v1/orgs/${encodeURIComponent(orgSlug)}/posts/${encodeURIComponent(postId)}/schedule`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localTime }),
    },
  );

  // The server's answer, not ours. It resolved the wall time in the workspace's
  // zone, so it is the only party that knows what instant this actually became
  // — and on a DST Sunday that is not the instant the browser would compute.
  if (response.ok) return (await response.json()) as { scheduledFor: string };

  const body: unknown = await response.json().catch(() => null);
  const envelope =
    body && typeof body === 'object' && 'error' in body
      ? (body as { error: Record<string, unknown> }).error
      : {};

  throw new ApiError(response.status, {
    ...envelope,
    message:
      typeof envelope['message'] === 'string'
        ? envelope['message']
        : 'That post could not be rescheduled.',
  });
}
