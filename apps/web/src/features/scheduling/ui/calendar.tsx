'use client';

import * as React from 'react';
import Link from 'next/link';
import type { PostStatus } from '@orbit/core';
import { Badge, Button, Card, CardBody, Empty, ErrorState, Loading, cn } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';
import { STATUS_LABEL, STATUS_TONE } from '@/features/posts/ui/status';

/**
 * The month calendar (SRS §12).
 *
 * Two things drive the design:
 *
 *   • **Both zones are shown when they differ** (assumption C5). A post is
 *     scheduled in the workspace's zone; the viewer reads it in theirs. Showing
 *     only one is how a client in Hanoi and an agency in London disagree about
 *     what day something goes out.
 *   • **Drag-and-drop is optimistic, and honest when it fails.** The card moves
 *     immediately, and snaps back with the server's message if the move was
 *     refused — a silent revert would leave the user believing it worked.
 */

export interface CalendarPost {
  id: string;
  title: string | null;
  body: string;
  status: PostStatus;
  scheduledFor: string | null;
  /** The zone the schedule was expressed in. */
  timezone: string | null;
  variants: Array<{ id: string; platform: string; status: string; accountName: string }>;
}

export interface CalendarProps {
  orgSlug: string;
  posts: CalendarPost[];
  /** First day of the month being shown, as YYYY-MM-DD. */
  month: string;
  /** The viewer's zone — display only. */
  viewerTimeZone: string;
  /** Whether this principal may drag posts to a new day. */
  canReschedule: boolean;
}

interface DayCell {
  key: string;
  date: Date;
  inMonth: boolean;
  posts: CalendarPost[];
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function Calendar(props: CalendarProps) {
  const [posts, setPosts] = React.useState(props.posts);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setPosts(props.posts);
  }, [props.posts]);

  const cells = React.useMemo(
    () => buildMonthGrid(props.month, posts, props.viewerTimeZone),
    [props.month, posts, props.viewerTimeZone],
  );

  async function moveTo(postId: string, day: Date) {
    const post = posts.find((p) => p.id === postId);
    if (!post?.scheduledFor) return;

    // Keep the time of day, change the date — the natural reading of dragging a
    // card to another square.
    const original = new Date(post.scheduledFor);
    const wall = wallPartsIn(original, post.timezone ?? props.viewerTimeZone);
    const target = wallPartsIn(day, props.viewerTimeZone);

    const optimistic = posts.map((p) =>
      p.id === postId ? { ...p, scheduledFor: shiftDate(original, day).toISOString() } : p,
    );
    setPosts(optimistic);
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/orgs/${encodeURIComponent(props.orgSlug)}/posts/${postId}/schedule`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            localTime: {
              year: target.year,
              month: target.month,
              day: target.day,
              // The hour and minute keep their meaning in the post's own zone,
              // which is the workspace's — the server resolves it there.
              hour: wall.hour,
              minute: wall.minute,
            },
          }),
        },
      );

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const envelope =
          body && typeof body === 'object' && 'error' in body
            ? (body as { error: ConstructorParameters<typeof ApiError>[1] }).error
            : {};
        throw new ApiError(response.status, envelope);
      }

      const result = (await response.json()) as { scheduledFor: string };
      setPosts((current) =>
        current.map((p) => (p.id === postId ? { ...p, scheduledFor: result.scheduledFor } : p)),
      );
    } catch (e) {
      // Snap back and say why. A silent revert would leave the user believing
      // the move worked.
      setPosts(props.posts);
      setError(e instanceof ApiError ? e : new ApiError(500, { message: 'The move failed.' }));
    } finally {
      setBusy(false);
      setDragging(null);
    }
  }

  return (
    <div className="space-y-4">
      {error ? (
        <ErrorState
          title="That post didn't move"
          description={error.message}
          {...(error.correlationId ? { correlationId: error.correlationId } : {})}
          onRetry={() => {
            setError(null);
          }}
          retryLabel="Dismiss"
        />
      ) : null}

      <div className="overflow-x-auto">
        <div className="grid min-w-[44rem] grid-cols-7 gap-px rounded-lg border border-line bg-line">
          {WEEKDAYS.map((day) => (
            <div
              key={day}
              className="bg-surface-sunken px-2 py-1.5 text-center text-xs font-medium text-ink-muted"
            >
              {day}
            </div>
          ))}

          {cells.map((cell) => (
            <DaySquare
              key={cell.key}
              cell={cell}
              orgSlug={props.orgSlug}
              viewerTimeZone={props.viewerTimeZone}
              canReschedule={props.canReschedule && !busy}
              isDragTarget={dragging !== null}
              onDropPost={(postId) => void moveTo(postId, cell.date)}
              onDragStart={setDragging}
            />
          ))}
        </div>
      </div>

      {posts.length === 0 ? (
        <Empty
          title="Nothing scheduled this month"
          description="Approved posts you schedule will appear here."
        />
      ) : null}
    </div>
  );
}

function DaySquare({
  cell,
  orgSlug,
  viewerTimeZone,
  canReschedule,
  isDragTarget,
  onDropPost,
  onDragStart,
}: {
  cell: DayCell;
  orgSlug: string;
  viewerTimeZone: string;
  canReschedule: boolean;
  isDragTarget: boolean;
  onDropPost: (postId: string) => void;
  onDragStart: (postId: string | null) => void;
}) {
  const [over, setOver] = React.useState(false);

  return (
    <div
      className={cn(
        'min-h-28 bg-surface p-1.5',
        !cell.inMonth && 'bg-surface-sunken',
        over && canReschedule && 'ring-2 ring-inset ring-accent',
      )}
      onDragOver={(event) => {
        if (!canReschedule) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        if (!canReschedule) return;
        const postId = event.dataTransfer.getData('text/plain');
        if (postId) onDropPost(postId);
      }}
    >
      <p
        className={cn('mb-1 px-0.5 text-xs', cell.inMonth ? 'text-ink-muted' : 'text-ink-muted/50')}
      >
        {cell.date.getUTCDate()}
      </p>

      <ul className="space-y-1">
        {cell.posts.map((post) => (
          <li key={post.id}>
            <PostChip
              post={post}
              orgSlug={orgSlug}
              viewerTimeZone={viewerTimeZone}
              draggable={canReschedule && post.status === 'SCHEDULED'}
              onDragStart={onDragStart}
            />
          </li>
        ))}
      </ul>
      {isDragTarget ? null : null}
    </div>
  );
}

function PostChip({
  post,
  orgSlug,
  viewerTimeZone,
  draggable,
  onDragStart,
}: {
  post: CalendarPost;
  orgSlug: string;
  viewerTimeZone: string;
  draggable: boolean;
  onDragStart: (postId: string | null) => void;
}) {
  const scheduled = post.scheduledFor ? new Date(post.scheduledFor) : null;
  const workspaceZone = post.timezone;

  const viewerTime = scheduled ? timeIn(scheduled, viewerTimeZone) : null;
  const workspaceTime = scheduled && workspaceZone ? timeIn(scheduled, workspaceZone) : null;

  // Assumption C5: show the second zone only when it actually differs.
  const showBoth = workspaceTime !== null && workspaceTime !== viewerTime;

  return (
    <Link
      href={`/orgs/${orgSlug}/posts/${post.id}`}
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', post.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart(post.id);
      }}
      onDragEnd={() => {
        onDragStart(null);
      }}
      className={cn(
        'block rounded border border-line bg-surface-raised px-1.5 py-1 text-xs',
        'hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        draggable && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <span className="flex items-center gap-1">
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            post.status === 'PUBLISHED' && 'bg-success',
            post.status === 'SCHEDULED' && 'bg-accent',
            post.status === 'FAILED' && 'bg-danger',
            post.status === 'PARTIALLY_PUBLISHED' && 'bg-warning',
          )}
        />
        <span className="truncate font-medium text-ink">
          {viewerTime}
          {showBoth ? (
            <span className="font-normal text-ink-muted"> · {workspaceTime} local</span>
          ) : null}
        </span>
      </span>

      <span className="mt-0.5 block truncate text-ink-muted">
        {post.title ?? post.body.trim().slice(0, 40) ?? 'Untitled'}
      </span>
    </Link>
  );
}

// ── Date helpers ────────────────────────────────────────────────────────────
//
// The grid is laid out in the *viewer's* zone, so a post scheduled at 08:00
// Hanoi lands on the day the viewer would call it — which is the whole point of
// the display zone being separate from the scheduling zone.

function timeIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function wallPartsIn(date: Date, timeZone: string) {
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

/** The same clock time, on a different date. */
function shiftDate(original: Date, targetDay: Date): Date {
  const shifted = new Date(original);
  shifted.setUTCFullYear(
    targetDay.getUTCFullYear(),
    targetDay.getUTCMonth(),
    targetDay.getUTCDate(),
  );
  return shifted;
}

function dayKeyIn(date: Date, timeZone: string): string {
  const parts = wallPartsIn(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/**
 * Six weeks of squares, Monday-first, covering the month.
 *
 * Built from UTC-noon anchors so the grid arithmetic never crosses a DST
 * boundary — the squares are labels, not instants, and using midnight would
 * make a day vanish in zones that skip it.
 */
function buildMonthGrid(month: string, posts: CalendarPost[], timeZone: string): DayCell[] {
  const [year, monthNumber] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 1, 1, 12));

  // Monday = 0.
  const leading = (first.getUTCDay() + 6) % 7;
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - leading);

  const byDay = new Map<string, CalendarPost[]>();
  for (const post of posts) {
    if (!post.scheduledFor) continue;
    const key = dayKeyIn(new Date(post.scheduledFor), timeZone);
    byDay.set(key, [...(byDay.get(key) ?? []), post]);
  }

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);

    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

    return {
      key,
      date,
      inMonth: date.getUTCMonth() === (monthNumber ?? 1) - 1,
      posts: (byDay.get(key) ?? []).sort((a, b) =>
        (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? ''),
      ),
    };
  });
}

/** Compact list view — the same data, for narrow screens and scanning. */
export function CalendarList({
  posts,
  orgSlug,
  viewerTimeZone,
}: {
  posts: CalendarPost[];
  orgSlug: string;
  viewerTimeZone: string;
}) {
  if (posts.length === 0) {
    return <Empty title="Nothing scheduled" description="Scheduled posts will appear here." />;
  }

  return (
    <ul className="space-y-2">
      {posts.map((post) => {
        const scheduled = post.scheduledFor ? new Date(post.scheduledFor) : null;
        const viewerTime = scheduled ? timeIn(scheduled, viewerTimeZone) : '—';
        const workspaceTime = scheduled && post.timezone ? timeIn(scheduled, post.timezone) : null;

        return (
          <li key={post.id}>
            <Card>
              <CardBody className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm text-ink">
                  {scheduled ? dayKeyIn(scheduled, viewerTimeZone) : '—'} {viewerTime}
                </span>
                {workspaceTime && workspaceTime !== viewerTime ? (
                  <span className="text-xs text-ink-muted">{workspaceTime} local</span>
                ) : null}
                <Link
                  href={`/orgs/${orgSlug}/posts/${post.id}`}
                  className="min-w-0 flex-1 truncate text-sm font-medium text-ink hover:underline"
                >
                  {post.title ?? post.body.trim().slice(0, 60) ?? 'Untitled'}
                </Link>
                <Badge tone={STATUS_TONE[post.status]}>{STATUS_LABEL[post.status]}</Badge>
              </CardBody>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

/** Re-exported so the page can render a loading state with the same shell. */
export function CalendarLoading() {
  return <Loading label="Loading the calendar" rows={6} />;
}

export { Button };
