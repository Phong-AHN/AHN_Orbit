'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * "Check now" for the inbox.
 *
 * ## Why an inbox needs this at all
 *
 * The queue is filled by a worker sweep — every 15 minutes for a post under two
 * days old, every two hours after that. That is the right cadence for the
 * steady state and the wrong one for the two cases people actually hit: a
 * client has just phoned about a comment, or somebody is demonstrating the
 * product. Without this the only recourse is reloading the page, which does
 * nothing, and then distrusting the screen.
 *
 * ## It reports what it did, not what it found
 *
 * The work is asynchronous: this enqueues the same job the sweep enqueues and
 * the worker reads the platform a moment later. So the message says the check
 * has started and the page is refreshed to show whatever has landed. Promising
 * "3 new comments" here would mean inventing a number before the job has run.
 *
 * `router.refresh()` rather than a poll loop: the server component re-renders
 * with whatever the worker has written by then, and a comment that lands a
 * second later appears on the next press or the next sweep. That is honest
 * about a queue which is eventually consistent, rather than pretending it is
 * not.
 *
 * ## The refusal is expected, not exceptional
 *
 * Meta's rate limit is per app, so a held-down button spends quota belonging to
 * every other tenant. The server allows one check a minute per organization and
 * a second press is a 429 — shown as the plain sentence the server sends,
 * because "you just did that" is information rather than a failure.
 */
export function SyncButton({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);

  async function check() {
    setBusy(true);

    try {
      await apiRequest(`/api/v1/orgs/${orgSlug}/community/sync`, { method: 'POST' });
      toast.show('Checking for new comments. They appear within a few seconds.', 'success');
      router.refresh();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : 'That did not work.', 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="secondary" onClick={check} loading={busy} loadingLabel="Checking">
      Check now
    </Button>
  );
}
