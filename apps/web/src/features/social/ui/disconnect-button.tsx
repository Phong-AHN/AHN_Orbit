'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Hand the connection back (SRS §7).
 *
 * Behind a confirmation, and the confirmation says what actually happens rather
 * than asking "are you sure?" — because the consequences are unevenly
 * distributed and only one of them is obvious:
 *
 *   • the stored tokens are **deleted**, and getting the account back means
 *     signing in at the platform again;
 *   • posts already published **stay**, with their analytics — the account row
 *     is soft-deleted precisely so that history keeps its reference;
 *   • scheduled posts **block** the disconnect rather than being silently
 *     cancelled. That refusal arrives from the server as a conflict, and it is
 *     shown verbatim: it names how many there are, which is the number somebody
 *     needs in order to decide what to do next.
 *
 * The server also tells the platform to revoke, on a best-effort basis. A
 * revoke that fails does not stop the local disconnect — the user asked for
 * this, and leaving an account connected because TikTok had a bad minute would
 * be the wrong way round.
 */

export interface DisconnectButtonProps {
  orgSlug: string;
  accountId: string;
  accountName: string;
  platform: string;
}

export function DisconnectButton({
  orgSlug,
  accountId,
  accountName,
  platform,
}: DisconnectButtonProps) {
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function disconnect() {
    setBusy(true);
    setError(null);

    try {
      await apiRequest(
        `/api/v1/orgs/${encodeURIComponent(orgSlug)}/social-accounts/${encodeURIComponent(accountId)}`,
        { method: 'DELETE' },
      );

      toast.show(`${accountName} disconnected.`);
      setOpen(false);
      router.refresh();
    } catch (e) {
      // Kept on screen rather than dropped into a toast: the common refusal is
      // "this account has N scheduled posts", which is something to read and
      // act on, not something to glance at while it fades.
      setError(e instanceof ApiError ? e.message : 'That account could not be disconnected.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        Disconnect
      </Button>

      <ConfirmDialog
        open={open}
        busy={busy}
        onClose={() => setOpen(false)}
        onConfirm={disconnect}
        title={`Disconnect ${accountName}?`}
        description={`Orbit will stop publishing to this ${platform.toLowerCase()} account.`}
        confirmLabel="Disconnect"
        tone="danger"
      >
        <ul className="space-y-1.5 text-sm text-ink-secondary">
          <li>
            The stored access tokens are deleted. Connecting again means signing in at{' '}
            {platform.toLowerCase()} once more.
          </li>
          <li>Posts already published stay where they are, and keep their analytics.</li>
          <li>
            Anything still scheduled to this account has to be cancelled or rescheduled first —
            Orbit will say so rather than quietly dropping it.
          </li>
        </ul>

        {error ? (
          <p role="alert" className="mt-3 text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
