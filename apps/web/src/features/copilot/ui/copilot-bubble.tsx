'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';
import type { CopilotMessage } from '../service';
import { ASSISTANT_NAME } from '../name';
import { CopilotChat } from './copilot-chat';

/**
 * The Copilot as a chat bubble in the bottom-right corner of every page (D-109).
 *
 * The same conversation as the full Copilot page — same threads, same server
 * loop, same confirmation cards — in a panel that stays put while the person
 * moves around the product. It reopens the last thread they used here; the
 * thread id is the only thing kept in the browser, and the thread itself is
 * fetched from the server, which checks it is theirs.
 */

const storageKey = (orgSlug: string) => `copilot:thread:${orgSlug}`;

function readStored(orgSlug: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(orgSlug));
  } catch {
    return null;
  }
}

function writeStored(orgSlug: string, threadId: string | null) {
  try {
    if (threadId) window.localStorage.setItem(storageKey(orgSlug), threadId);
    else window.localStorage.removeItem(storageKey(orgSlug));
  } catch {
    // Private browsing or blocked storage: the bubble just starts fresh.
  }
}

type Loaded = { threadId: string | null; messages: CopilotMessage[]; key: string };

export function CopilotBubble({ orgSlug }: { orgSlug: string }) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const panelId = React.useId();
  const button = React.useRef<HTMLButtonElement>(null);

  const startFresh = React.useCallback(() => {
    writeStored(orgSlug, null);
    setLoaded({ threadId: null, messages: [], key: `new-${Date.now()}` });
  }, [orgSlug]);

  // Load the last thread the first time the panel opens.
  React.useEffect(() => {
    if (!open || loaded || loading) return;
    const stored = readStored(orgSlug);
    if (!stored) {
      startFresh();
      return;
    }
    setLoading(true);
    setError(null);
    apiRequest<{ thread: { id: string; messages: CopilotMessage[] } }>(
      `/api/v1/orgs/${encodeURIComponent(orgSlug)}/copilot/threads/${encodeURIComponent(stored)}`,
    )
      .then(({ thread }) =>
        setLoaded({ threadId: thread.id, messages: thread.messages, key: thread.id }),
      )
      .catch((e: unknown) => {
        // Gone or not theirs: start a new conversation rather than show an error.
        if (e instanceof ApiError && e.status === 404) startFresh();
        else setError(`${ASSISTANT_NAME} could not load your conversation.`);
      })
      .finally(() => setLoading(false));
  }, [open, loaded, loading, orgSlug, startFresh]);

  // Escape closes, and focus goes back to the bubble.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Focus the message box when the panel opens.
  React.useEffect(() => {
    if (open && loaded) document.getElementById('copilot-bubble-input')?.focus();
  }, [open, loaded]);

  // The full Copilot page is already the conversation; a second one on top would compete.
  if (pathname?.endsWith('/copilot')) return null;

  const fullView = `/orgs/${orgSlug}/copilot${loaded?.threadId ? `?thread=${loaded.threadId}` : ''}`;

  return (
    <>
      {open ? (
        <section
          id={panelId}
          role="dialog"
          aria-label={ASSISTANT_NAME}
          className={cn(
            'fixed bottom-20 right-4 z-40 flex flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-xl',
            'w-[min(26rem,calc(100vw-2rem))] h-[min(38rem,calc(100dvh-7rem))]',
          )}
        >
          <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <span aria-hidden className="h-2 w-2 rounded-full bg-success" />
            <h2 className="flex-1 text-sm font-semibold text-ink">{ASSISTANT_NAME}</h2>
            <button
              type="button"
              onClick={startFresh}
              className="rounded px-2 py-1 text-xs text-ink-secondary hover:bg-surface-sunken hover:text-ink"
            >
              New chat
            </button>
            <Link
              href={fullView}
              onClick={() => setOpen(false)}
              className="rounded px-2 py-1 text-xs text-ink-secondary hover:bg-surface-sunken hover:text-ink"
            >
              Full view
            </Link>
            <button
              type="button"
              aria-label={`Close ${ASSISTANT_NAME}`}
              onClick={() => {
                setOpen(false);
                button.current?.focus();
              }}
              className="rounded px-2 py-1 text-sm text-ink-secondary hover:bg-surface-sunken hover:text-ink"
            >
              ✕
            </button>
          </header>
          <div className="min-h-0 flex-1 p-4">
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : loading || !loaded ? (
              <p className="text-sm text-ink-muted">Loading…</p>
            ) : (
              <CopilotChat
                key={loaded.key}
                compact
                orgSlug={orgSlug}
                threadId={loaded.threadId}
                initialMessages={loaded.messages}
                onThreadCreated={(threadId) => writeStored(orgSlug, threadId)}
              />
            )}
          </div>
        </section>
      ) : null}

      <button
        ref={button}
        type="button"
        data-tour="squire"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={open ? `Close ${ASSISTANT_NAME}` : `Open ${ASSISTANT_NAME}`}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'fixed bottom-4 right-4 z-40 inline-flex h-12 items-center gap-2 rounded-full px-4 shadow-lg',
          'bg-accent text-sm font-medium text-accent-ink hover:opacity-90',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        )}
      >
        <ChatIcon />
        <span className="hidden sm:inline">{open ? 'Close' : ASSISTANT_NAME}</span>
      </button>
    </>
  );
}

function ChatIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 8.25h9m-9 3.75h5.25M21 12c0 4.556-4.03 8.25-9 8.25a9.77 9.77 0 0 1-3.93-.81L3 20.25l1.4-3.73A7.94 7.94 0 0 1 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"
      />
    </svg>
  );
}
