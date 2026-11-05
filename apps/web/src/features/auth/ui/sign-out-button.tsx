'use client';

import * as React from 'react';
import { Button } from '@orbit/ui';

/**
 * Sign out of Social Square.
 *
 * `DELETE /api/v1/auth/session` clears the cookie and revokes the person's
 * refresh tokens, so a copy of the cookie taken earlier stops working too.
 * Then a full navigation rather than a router push: everything this tab holds
 * in memory — notifications, the Copilot conversation, cached pages — belongs
 * to the session that just ended and should not survive it.
 */
export function SignOutButton({
  className,
  label = 'Sign out',
  appearance = 'rail',
}: {
  className?: string;
  label?: string;
  /** `rail` fills the foot of the sidebar; `link` sits inside a sentence. */
  appearance?: 'rail' | 'link';
}) {
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  async function signOut() {
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch('/api/v1/auth/session', { method: 'DELETE' });
      if (!response.ok && response.status !== 204) throw new Error(String(response.status));
      window.location.assign('/sign-in');
    } catch {
      // The server clears the cookie even for a dead session, so a failure
      // here is the network. Say so rather than pretending it worked.
      setFailed(true);
      setBusy(false);
    }
  }

  if (appearance === 'link') {
    return (
      <span className={className}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void signOut()}
          className="rounded font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60"
        >
          {busy ? 'Signing out…' : label}
        </button>
        {failed ? (
          <span role="alert" className="ml-2 text-xs font-medium text-danger">
            Could not sign out. Try again.
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <div className={className}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        loading={busy}
        disabled={busy}
        onClick={() => void signOut()}
        className="w-full justify-start"
      >
        {label}
      </Button>
      {failed ? (
        <p role="alert" className="mt-1 px-2 text-xs font-medium text-danger">
          Could not sign out. Check the connection and try again.
        </p>
      ) : null}
    </div>
  );
}
