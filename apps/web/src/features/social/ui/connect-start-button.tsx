'use client';

import * as React from 'react';
import { Button } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';
import { startConnect } from '@/features/tenancy/ui/api';

/**
 * Sends the browser to the platform's authorization screen.
 *
 * A full navigation, not a popup — the OAuth state cookie is set on the
 * response that produces this URL, and a popup buys a window-messaging dance
 * and a blocker to fail against for nothing. Same reasoning as
 * `ReconnectButton`, which is the reconnection half of this flow.
 */
export interface ConnectStartButtonProps {
  orgSlug: string;
  platform: string;
  workspaceId: string;
  brandId: string;
  /** Where the callback returns the browser — must be a relative path. */
  returnTo: string;
  label: string;
}

export function ConnectStartButton({
  orgSlug,
  platform,
  workspaceId,
  brandId,
  returnTo,
  label,
}: ConnectStartButtonProps) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);

    try {
      const { authorizationUrl } = await startConnect(orgSlug, platform, {
        workspaceId,
        brandId,
        returnTo,
      });

      // Leaving the app: the busy state stays on so the button does not look
      // ready again while the navigation is still in flight.
      window.location.assign(authorizationUrl);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'We could not start the connection. Please try again in a moment.',
      );
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button loading={busy} disabled={busy} onClick={() => void start()}>
        {label}
      </Button>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
