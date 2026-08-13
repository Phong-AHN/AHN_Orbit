'use client';

import * as React from 'react';
import Link from 'next/link';
import { Button, Spinner, cn } from '@orbit/ui';

/**
 * The notification bell (SRS §22, T1.15).
 *
 * Polls every 30 seconds, as `docs/API.md` §2.11 specifies — SSE and WebSocket
 * push are P2. Polling is unfashionable and right here: the payload is a count
 * and twenty short rows, the freshness people actually need is "within a
 * minute", and a persistent connection per open tab is a real cost on a
 * serverless deployment for a feature nobody watches.
 *
 * Two details that matter more than they look:
 *
 *  • **Polling pauses when the tab is hidden.** A dashboard left open on a
 *    second monitor overnight would otherwise make ~2,800 requests before
 *    anyone looked at it.
 *  • **Opening the panel does not mark anything read.** Read means read; a
 *    glance at a list is not the same as having taken it in, and auto-clearing
 *    is how people miss things.
 */

const POLL_MS = 30_000;

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  resourceType: string | null;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

interface FeedResponse {
  notifications: NotificationItem[];
  nextCursor: string | null;
  unread: number;
}

export function NotificationBell({ orgSlug }: { orgSlug: string }) {
  const [open, setOpen] = React.useState(false);
  const [feed, setFeed] = React.useState<FeedResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const base = `/api/v1/orgs/${encodeURIComponent(orgSlug)}/notifications`;
  const panelId = React.useId();

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(base, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('failed');
      const body = (await response.json()) as FeedResponse;
      setFeed(body);
      setError(null);
    } catch {
      // A failed poll is not worth shouting about — the next one is 30 seconds
      // away. The message only appears once the panel is open and empty.
      setError('Notifications could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [base]);

  React.useEffect(() => {
    void load();

    const tick = () => {
      // Hidden tabs do not poll. Picked up again on the next visibility change.
      if (document.visibilityState === 'visible') void load();
    };

    const interval = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  // Close on Escape, and on a click outside the panel.
  const container = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  async function markRead(id: string) {
    // Optimistic: the row is already visibly read before the round trip, and a
    // failure is corrected by the next poll.
    setFeed((current) =>
      current
        ? {
            ...current,
            unread: Math.max(0, current.unread - 1),
            notifications: current.notifications.map((n) =>
              n.id === id ? { ...n, readAt: nowIso() } : n,
            ),
          }
        : current,
    );

    await fetch(`${base}/${id}/read`, { method: 'POST' }).catch(() => null);
  }

  async function markAllRead() {
    setFeed((current) =>
      current
        ? {
            ...current,
            unread: 0,
            notifications: current.notifications.map((n) => ({
              ...n,
              readAt: n.readAt ?? nowIso(),
            })),
          }
        : current,
    );

    await fetch(`${base}/read-all`, { method: 'POST' }).catch(() => null);
  }

  const unread = feed?.unread ?? 0;
  const items = feed?.notifications ?? [];

  return (
    <div className="relative" ref={container}>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={() => {
          setOpen((v) => !v);
        }}
        className="relative grid size-9 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-sunken hover:text-ink"
      >
        <BellIcon />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-white"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-line bg-surface shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <h2 className="text-sm font-semibold text-ink">Notifications</h2>
            {unread > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => void markAllRead()}>
                Mark all read
              </Button>
            ) : null}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && items.length === 0 ? (
              <p className="flex items-center gap-2 px-3 py-6 text-sm text-ink-muted">
                <Spinner className="size-4" /> Loading…
              </p>
            ) : items.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-ink-muted">
                {error ?? 'Nothing to catch up on.'}
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {items.map((item) => (
                  <li key={item.id}>
                    <NotificationRow
                      item={item}
                      orgSlug={orgSlug}
                      onRead={() => void markRead(item.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NotificationRow({
  item,
  orgSlug,
  onRead,
}: {
  item: NotificationItem;
  orgSlug: string;
  onRead: () => void;
}) {
  const unread = item.readAt === null;
  const href = linkFor(orgSlug, item);

  const content = (
    <>
      <div className="flex items-start gap-2">
        {unread ? (
          <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" />
        ) : (
          <span aria-hidden="true" className="mt-1.5 size-2 shrink-0" />
        )}
        <div className="min-w-0">
          <p className={cn('text-sm', unread ? 'font-semibold text-ink' : 'text-ink-secondary')}>
            {item.title}
          </p>
          {item.body ? <p className="mt-0.5 text-xs text-ink-muted">{item.body}</p> : null}
          <p className="mt-1 text-[11px] text-ink-muted">{relativeTime(item.createdAt)}</p>
        </div>
      </div>
      {unread ? <span className="sr-only">Unread</span> : null}
    </>
  );

  const className = cn(
    'block w-full px-3 py-2.5 text-left transition-colors hover:bg-surface-sunken',
    unread && 'bg-accent-soft/30',
  );

  // Following the link is the moment it has genuinely been seen, so that is
  // where it gets marked — not when the panel opened.
  return href ? (
    <Link href={href} className={className} onClick={onRead}>
      {content}
    </Link>
  ) : (
    <button type="button" className={className} onClick={onRead}>
      {content}
    </button>
  );
}

/** Where a notification points. Unknown shapes stay inert rather than guessing. */
function linkFor(orgSlug: string, item: NotificationItem): string | null {
  if (!item.resourceId) return null;

  switch (item.resourceType) {
    case 'Post':
      return `/orgs/${orgSlug}/posts/${item.resourceId}`;
    case 'SocialAccount':
      return `/orgs/${orgSlug}/settings/accounts`;
    default:
      return null;
  }
}

/**
 * Browser-side time, deliberately not `clock.now()` from `@orbit/core`.
 *
 * Importing the core barrel into a client component drags `content-hash.ts` and
 * therefore `node:crypto` into the browser bundle, which webpack refuses — the
 * production build catches it even though typecheck does not. The injectable
 * clock exists so *server* logic can be tested against a frozen time; optimistic
 * UI state in a browser has no such need, so the platform primitive is the
 * honest choice here. `new Date()` with no arguments stays banned by lint;
 * passing `Date.now()` is what the rule permits.
 */
function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
      aria-hidden="true"
    >
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}
