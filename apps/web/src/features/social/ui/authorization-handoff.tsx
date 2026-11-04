'use client';

import * as React from 'react';
import { Button } from '@orbit/ui';

/**
 * Leaving for a platform's sign-in page, and what to do when the phone sends
 * the link somewhere else.
 *
 * On Android, a link to `x.com`, `tiktok.com`, `facebook.com` and the rest is
 * handed to the platform's app when it is installed (App Links). Several of
 * those apps do not implement the OAuth screen: X opens its timeline and drops
 * the request, so the connection never comes back and nothing explains why.
 * A website cannot switch App Links off.
 *
 * Two things make it recoverable. When the link is handed off, **this tab
 * never navigates** — it is still here when the person comes back. And Chrome
 * does not hand off an address **pasted into its address bar**. So if the tab
 * is still on screen after the hand-off, it offers the link to copy and paste.
 *
 * Nothing in the link is secret: it carries the flow's nonce and a PKCE
 * challenge. The signed state is in an HttpOnly cookie in this browser, so the
 * link completes only here, in this session, within ten minutes.
 */

/** Long enough for a real navigation to have unloaded the page. */
const STILL_HERE_MS = 6_000;

export function useAuthorizationHandoff(onReturnedFromCache: () => void) {
  const [stranded, setStranded] = React.useState<string | null>(null);
  const cleanup = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    // Back from the platform's page on a phone restores this page from the
    // back-forward cache, with the button still spinning. Let it be pressed.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) onReturnedFromCache();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
      cleanup.current?.();
    };
  }, [onReturnedFromCache]);

  const leave = React.useCallback((url: string) => {
    cleanup.current?.();
    let hidden = false;

    // The app opening hides this tab; coming back shows it again, and a tab
    // that navigated would not be here to see either.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hidden = true;
      else if (hidden) setStranded(url);
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setTimeout(() => setStranded(url), STILL_HERE_MS);

    cleanup.current = () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearTimeout(timer);
    };

    window.location.assign(url);
  }, []);

  return { leave, stranded };
}

export function StrandedAuthorization({
  url,
  platformName,
}: {
  url: string;
  /** "X", "TikTok". Absent where the caller does not know the platform. */
  platformName?: string | undefined;
}) {
  const [copied, setCopied] = React.useState(false);
  const fieldId = React.useId();

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard access: the field below is selectable by hand.
      (document.getElementById(fieldId) as HTMLInputElement | null)?.select();
    }
  }

  return (
    <div
      role="status"
      className="max-w-measure space-y-2 rounded-lg border border-line bg-surface-sunken p-3 text-sm"
    >
      <p className="font-medium text-ink">
        {platformName ? `Did the ${platformName} app open instead?` : 'Did an app open instead?'}
      </p>
      <p className="text-ink-secondary">
        Some phones send sign-in links to the installed app, which then drops the request. Copy this
        link, paste it into this browser&rsquo;s address bar, and sign in there — you will come back
        here when it is done. It works only in this browser, for ten minutes.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy sign-in link'}
        </Button>
        <a href={url} className="text-sm text-accent underline-offset-2 hover:underline">
          Try the link again
        </a>
      </div>
      <label htmlFor={fieldId} className="sr-only">
        Sign-in link
      </label>
      <input
        id={fieldId}
        readOnly
        value={url}
        onFocus={(event) => event.currentTarget.select()}
        className="w-full truncate rounded-sm border border-line bg-surface px-2 py-1 font-mono text-xs text-ink-muted"
      />
    </div>
  );
}
