'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, useToast } from '@orbit/ui';
import { ApiError, apiRequest } from '@/features/posts/ui/api';

/**
 * Rename an agency, a client or a brand, in place.
 *
 * One component for all three because they are the same act against three
 * endpoints that already existed — `PATCH` with `{ name }`, each checked
 * against its own permission and audited. Only the display name changes: the
 * slug, every link and every connected account stay exactly as they were.
 *
 * Rendered only for people who may rename the thing; the API refuses
 * everybody else regardless.
 */
export function RenameButton({
  endpoint,
  currentName,
  noun,
}: {
  /** The resource's PATCH endpoint, built by the page. */
  endpoint: string;
  currentName: string;
  /** What is being renamed, for the label and messages: "client", "brand". */
  noun: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const inputId = React.useId();

  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(currentName);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function close() {
    setEditing(false);
    setValue(currentName);
    setError(null);
  }

  async function save() {
    const name = value.trim();
    if (name === currentName) return close();
    // The API's own rule, said before the round trip rather than after it.
    if (name.length < 2 || name.length > 120) {
      setError('A name needs 2 to 120 characters.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await apiRequest(endpoint, { method: 'PATCH', body: JSON.stringify({ name }) });
      toast.show(`Renamed to ${name}.`);
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `The ${noun} could not be renamed.`);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Rename ${currentName}`}
        onClick={() => {
          setValue(currentName);
          setEditing(true);
        }}
      >
        Rename
      </Button>
    );
  }

  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="min-w-[12rem] flex-1">
        <label htmlFor={inputId} className="sr-only">
          {`New ${noun} name`}
        </label>
        <Input
          id={inputId}
          value={value}
          maxLength={120}
          autoFocus
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
          }}
        />
        {error ? (
          <p id={`${inputId}-error`} role="alert" className="mt-1 text-xs font-medium text-danger">
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" size="sm" loading={busy} disabled={busy}>
        Save
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={close}>
        Cancel
      </Button>
    </form>
  );
}
