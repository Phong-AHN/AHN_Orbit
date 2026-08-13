'use client';

import * as React from 'react';
import { Button } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';

/**
 * The two-click fix (T1.7).
 *
 * The whole point of T1.7 is that a dead token stops being a dead end, so this
 * asks the server where to send the browser and then sends it. It deliberately
 * does not open a popup: the OAuth state cookie is set on this response, and a
 * popup adds a window-messaging dance and a blocker to fail against for no gain.
 *
 * `window.location.assign` rather than a router push because the destination is
 * the platform's own domain — Next's router would refuse it, and quietly.
 */

export interface ReconnectButtonProps {
  orgSlug: string;
  accountId: string;
  accountName: string;
  /** Where the callback should return the browser once the flow finishes. */
  returnTo?: string;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
}

export function ReconnectButton(props: ReconnectButtonProps) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/orgs/${encodeURIComponent(props.orgSlug)}/social-accounts/${props.accountId}/reconnect`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(props.returnTo ? { returnTo: props.returnTo } : {}),
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

      const body = (await response.json()) as { authorizationUrl: string };

      // Leaving the app entirely, so the busy state stays on: the button must
      // not look ready again while the navigation is still in flight.
      window.location.assign(body.authorizationUrl);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'We could not start reconnecting. Please try again in a moment.',
      );
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant={props.variant ?? 'primary'}
        size={props.size ?? 'sm'}
        loading={busy}
        disabled={busy}
        onClick={() => void start()}
      >
        Reconnect {props.accountName}
      </Button>

      {error ? (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
