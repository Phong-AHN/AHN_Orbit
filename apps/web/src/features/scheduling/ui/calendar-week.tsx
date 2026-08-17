'use client';

import * as React from 'react';
import Link from 'next/link';
import { Badge, Empty, ErrorState } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';
import {
  STATUS_LABEL,
  STATUS_TONE,
  dayKeyIn,
  reschedulePost,
  timeIn,
  wallPartsIn,
  weekdayIn,
  type CalendarPost,
} from './calendar-shared';

/**
 * The week view (SRS §7).
 *
 * Month answers "what is going out this month"; **week answers "what is going
 * out on Tuesday morning"** — and that second question is the one an agency
 * actually asks when it is deciding where a new post fits. A month square can
 * only ever say "3 posts"; a week column has room for the times, which is what
 * makes a gap visible.
 *
 * Dragging moves a post **to another day, keeping its time**. Drag-to-*time* is
 * deliberately not implemented: a grid of hour rows makes an eleven-minute
 * difference a pixel difference, and a schedule nudged by accident is worse
 * than one that takes two clicks to change. The time is edited on the post,
 * where it is typed rather than aimed at.
 */

export interface CalendarWeekProps {
  orgSlug: string;
  posts: CalendarPost[];
  /** Monday of the week being shown, as YYYY-MM-DD. */
  weekStart: string;
  viewerTimeZone: string;
  canReschedule: boolean;
  /**
   * Today, as `YYYY-MM-DD` in the viewer's zone, resolved on the server.
   *
   * Not computed here: `clock` is server-only (it reaches `node:crypto`), a raw
   * `new Date()` is banned so time stays injectable, and either would make the
   * highlighted column differ between the server's markup and the client's.
   * The page already knows what day it is; it just has to say so.
   */
  todayKey: string;
}

interface DayColumn {
  key: string;
  date: Date;
  isToday: boolean;
  posts: CalendarPost[];
}

export function CalendarWeek(props: CalendarWeekProps) {
  const [posts, setPosts] = React.useState(props.posts);
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    setPosts(props.posts);
  }, [props.posts]);

  const columns = React.useMemo(
    () => buildWeek(props.weekStart, posts, props.viewerTimeZone, props.todayKey),
    [props.weekStart, posts, props.viewerTimeZone, props.todayKey],
  );

  async function moveTo(postId: string, day: Date) {
    const post = posts.find((candidate) => candidate.id === postId);
    if (!post?.scheduledFor) return;

    const original = new Date(post.scheduledFor);
    const wall = wallPartsIn(original, post.timezone ?? props.viewerTimeZone);
    const target = wallPartsIn(day, props.viewerTimeZone);

    // Optimistic, with the real value kept so a refusal can put it back. A
    // calendar that shows a move the server rejected is a calendar that lies
    // about when a client's post is going out.
    const previous = posts;
    setPosts(
      posts.map((candidate) =>
        candidate.id === postId
          ? { ...candidate, scheduledFor: withDate(original, day).toISOString() }
          : candidate,
      ),
    );
    setBusy(true);
    setError(null);

    try {
      const result = await reschedulePost(props.orgSlug, postId, {
        year: target.year,
        month: target.month,
        day: target.day,
        // The hour keeps its meaning in the post's own zone — the workspace's —
        // which is where the server resolves it.
        hour: wall.hour,
        minute: wall.minute,
      });

      // Replace the optimistic guess with what the server actually resolved.
      setPosts((current) =>
        current.map((candidate) =>
          candidate.id === postId ? { ...candidate, scheduledFor: result.scheduledFor } : candidate,
        ),
      );
    } catch (failure) {
      setPosts(previous);
      setError(failure instanceof ApiError ? failure : null);
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
          onRetry={() => setError(null)}
          retryLabel="Dismiss"
        />
      ) : null}

      <div className="overflow-x-auto">
        <div className="grid min-w-[52rem] grid-cols-7 gap-px rounded-lg border border-line bg-line">
          {columns.map((column) => (
            <WeekColumn
              key={column.key}
              column={column}
              orgSlug={props.orgSlug}
              viewerTimeZone={props.viewerTimeZone}
              canReschedule={props.canReschedule && !busy}
              isDragTarget={dragging !== null}
              onDropPost={(postId) => void moveTo(postId, column.date)}
              onDragStart={setDragging}
            />
          ))}
        </div>
      </div>

      {posts.length === 0 ? (
        <Empty
          title="Nothing scheduled this week"
          description="Approved posts you schedule will appear here, with their times."
        />
      ) : null}
    </div>
  );
}

function WeekColumn({
  column,
  orgSlug,
  viewerTimeZone,
  canReschedule,
  isDragTarget,
  onDropPost,
  onDragStart,
}: {
  column: DayColumn;
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
      className={`min-h-[16rem] bg-surface p-2 ${over ? 'bg-accent-soft' : ''} ${
        column.isToday ? 'ring-1 ring-inset ring-accent/40' : ''
      }`}
      onDragOver={(event) => {
        if (!canReschedule || !isDragTarget) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        setOver(false);
        if (!canReschedule) return;
        const postId = event.dataTransfer.getData('text/plain');
        if (postId) onDropPost(postId);
      }}
    >
      <p className="mb-2 flex items-baseline gap-1.5 border-b border-line pb-1.5">
        <span className="text-xs font-medium text-ink-muted">
          {weekdayIn(column.date, viewerTimeZone)}
        </span>
        <span className={`text-sm font-semibold ${column.isToday ? 'text-accent' : 'text-ink'}`}>
          {column.date.getUTCDate()}
        </span>
        {column.isToday ? <span className="text-[11px] font-medium text-accent">today</span> : null}
      </p>

      {column.posts.length === 0 ? (
        <p className="text-xs text-ink-muted">—</p>
      ) : (
        <ul className="space-y-1.5">
          {column.posts.map((post) => {
            const scheduled = post.scheduledFor ? new Date(post.scheduledFor) : null;
            const viewerTime = scheduled ? timeIn(scheduled, viewerTimeZone) : '';
            const workspaceTime =
              scheduled && post.timezone ? timeIn(scheduled, post.timezone) : null;

            return (
              <li key={post.id}>
                <div
                  draggable={canReschedule && Boolean(post.scheduledFor)}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/plain', post.id);
                    event.dataTransfer.effectAllowed = 'move';
                    onDragStart(post.id);
                  }}
                  onDragEnd={() => onDragStart(null)}
                  className={`rounded border border-line bg-surface-sunken p-1.5 ${
                    canReschedule && post.scheduledFor ? 'cursor-grab active:cursor-grabbing' : ''
                  }`}
                >
                  <p className="flex items-baseline gap-1.5">
                    <span className="font-mono text-xs font-medium tabular-nums text-ink">
                      {viewerTime}
                    </span>
                    {/* Only when it differs — an agency in Hanoi scheduling for
                        a client in Sydney needs both, and everybody else needs
                        neither. */}
                    {workspaceTime && workspaceTime !== viewerTime ? (
                      <span className="text-[11px] text-ink-muted">{workspaceTime} local</span>
                    ) : null}
                  </p>

                  <Link
                    href={`/orgs/${orgSlug}/posts/${post.id}`}
                    className="mt-0.5 block truncate text-xs text-ink hover:underline"
                  >
                    {post.title ?? post.body.trim().slice(0, 40) ?? 'Untitled'}
                  </Link>

                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    <Badge tone={STATUS_TONE[post.status]}>{STATUS_LABEL[post.status]}</Badge>
                    {post.variants.slice(0, 2).map((variant) => (
                      <span key={variant.id} className="text-[11px] text-ink-muted">
                        {variant.platform.slice(0, 2)}
                      </span>
                    ))}
                    {post.variants.length > 2 ? (
                      <span className="text-[11px] text-ink-muted">
                        +{post.variants.length - 2}
                      </span>
                    ) : null}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Seven days from the Monday given, with each post on its own wall day. */
function buildWeek(
  weekStart: string,
  posts: CalendarPost[],
  timeZone: string,
  todayKey: string,
): DayColumn[] {
  const [year, month, day] = weekStart.split('-').map(Number);
  const start = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12));

  const byDay = new Map<string, CalendarPost[]>();
  for (const post of posts) {
    if (!post.scheduledFor) continue;
    const key = dayKeyIn(new Date(post.scheduledFor), timeZone);
    byDay.set(key, [...(byDay.get(key) ?? []), post]);
  }

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);

    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

    return {
      key,
      date,
      isToday: key === todayKey,
      posts: (byDay.get(key) ?? []).sort((a, b) =>
        (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? ''),
      ),
    };
  });
}

/** The original instant, moved to another day, keeping its time. */
function withDate(original: Date, day: Date): Date {
  const moved = new Date(original);
  moved.setUTCFullYear(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  return moved;
}
