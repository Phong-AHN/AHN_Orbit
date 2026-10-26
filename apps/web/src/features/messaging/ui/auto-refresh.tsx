'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-read the page every so often while somebody is looking at it (**D-107**).
 *
 * A conversation is live: the person may write again while it is open, and a
 * chat that only updates on reload is one people answer twice or not at all.
 * `router.refresh()` re-renders the server components and keeps client state,
 * so a reply half-typed in the composer survives it.
 *
 * Paused while the tab is hidden: nobody is reading it, and each refresh is a
 * database read.
 */
export function AutoRefresh({ intervalMs = 15_000 }: { intervalMs?: number }) {
  const router = useRouter();

  React.useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const timer = window.setInterval(tick, intervalMs);
    // Coming back to the tab brings it up to date at once rather than at the
    // next tick.
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [router, intervalMs]);

  return null;
}
