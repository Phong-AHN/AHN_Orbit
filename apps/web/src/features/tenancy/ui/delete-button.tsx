'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, ConfirmDialog, Input, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Delete a client or a brand.
 *
 * The confirm button stays shut until the name is typed. There is no undo in
 * the product — the row is soft-deleted and only support can bring it back —
 * so a dialog that can be clicked through by muscle memory is not enough.
 *
 * The server refuses while anything is still connected, and that refusal is
 * the message shown: "disconnect these accounts first" is the next step, not a
 * failure to apologise for.
 *
 * Rendered only for Owners and Admins (`workspace:delete`, `brand:delete`); the
 * API refuses everybody else regardless.
 */
export function DeleteButton({
  endpoint,
  name,
  noun,
  consequence,
  redirectTo,
}: {
  /** The resource's DELETE endpoint, built by the page. */
  endpoint: string;
  name: string;
  /** "client" or "brand", for the label and messages. */
  noun: string;
  /** What else goes with it, said before anybody confirms. */
  consequence: string;
  /** Where to go afterwards, when the current page was the thing deleted. */
  redirectTo?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const fieldId = React.useId();

  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function close() {
    if (busy) return;
    setOpen(false);
    setTyped('');
    setError(null);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(endpoint, { method: 'DELETE' });
      toast.show(`${name} was deleted.`);
      setOpen(false);
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `The ${noun} could not be deleted.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-danger hover:text-danger"
        aria-label={`Delete ${name}`}
        onClick={() => setOpen(true)}
      >
        Delete
      </Button>

      <ConfirmDialog
        open={open}
        onClose={close}
        onConfirm={confirm}
        title={`Delete ${name}?`}
        description={consequence}
        confirmLabel={`Delete ${noun}`}
        tone="danger"
        busy={busy}
        confirmDisabled={typed.trim() !== name.trim()}
      >
        <label htmlFor={fieldId} className="block text-sm text-ink-secondary">
          Type <span className="font-semibold text-ink">{name}</span> to confirm.
        </label>
        <Input
          id={fieldId}
          value={typed}
          autoComplete="off"
          disabled={busy}
          onChange={(event) => setTyped(event.target.value)}
          className="mt-1.5"
        />
        {error ? (
          <p role="alert" className="mt-2 text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
