'use client';

import * as React from 'react';
import { Button } from '@orbit/ui';
import { ApiError, apiRequest } from './api';

/**
 * Publish immediately, skipping the calendar.
 *
 * Two-step, deliberately. Every other action in the composer is reversible —
 * a status can be walked back, a schedule can be moved. This one leaves the
 * building: the moment the worker picks it up the post is on a real Page under
 * the client's name, and nothing in Orbit can take it back. A single button
 * next to "Schedule" would be one mis-click away from that.
 *
 * The confirmation names the number of accounts rather than asking "are you
 * sure?", because the fact worth checking is *how far* this goes, not whether
 * the click was intentional.
 *
 * Authorization is not decided here. `post:publish_now` is restricted to Owner,
 * Admin and Account Manager (docs/RBAC.md §4.4) — approvers approve, they do
 * not publish — and the endpoint re-checks regardless of what is on screen.
 */

export interface PublishNowButtonProps {
  orgSlug: string;
  postId: string;
  /** How many accounts this post goes to, for the confirmation. */
  accountCount: number;
  disabled?: boolean;
  onPublished: () => void;
}

export function PublishNowButton({
  orgSlug,
  postId,
  accountCount,
  disabled,
  onPublished,
}: PublishNowButtonProps) {
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function publish() {
    setBusy(true);
    setError(null);

    try {
      await apiRequest(`/api/v1/orgs/${encodeURIComponent(orgSlug)}/posts/${postId}/publish-now`, {
        method: 'POST',
      });

      setConfirming(false);
      setBusy(false);
      onPublished();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'We could not start publishing. Please try again in a moment.',
      );
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <Button
        className="w-full"
        variant="secondary"
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        Publish now
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded border border-warning/40 bg-warning/5 p-3">
      <p className="text-sm text-ink">
        This goes out to {accountCount} {accountCount === 1 ? 'account' : 'accounts'} straight away.
        Published posts cannot be unpublished from Orbit.
      </p>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button size="sm" loading={busy} disabled={busy} onClick={() => void publish()}>
          Publish now
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
