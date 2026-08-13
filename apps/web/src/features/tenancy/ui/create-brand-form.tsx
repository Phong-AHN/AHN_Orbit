'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';
import { createBrand } from './api';

/**
 * A brand inside a client workspace. Social accounts hang off brands, not
 * workspaces, so a workspace with no brand can never connect a Page — which is
 * why this is offered inline on every workspace rather than behind its own
 * screen.
 */
export interface CreateBrandFormProps {
  orgSlug: string;
  workspaceId: string;
  workspaceName: string;
}

export function CreateBrandForm({ orgSlug, workspaceId, workspaceName }: CreateBrandFormProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [website, setWebsite] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fieldId = `brand-name-${workspaceId}`;

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Add a brand
      </Button>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await createBrand(orgSlug, workspaceId, {
        name: name.trim(),
        ...(website.trim() ? { website: website.trim() } : {}),
      });

      setName('');
      setWebsite('');
      setOpen(false);
      setBusy(false);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'We could not create the brand. Please try again in a moment.',
      );
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-3 rounded border border-line bg-surface-sunken p-3"
      onSubmit={(e) => void submit(e)}
    >
      <Field label={`New brand in ${workspaceName}`} htmlFor={fieldId} required>
        <Input
          id={fieldId}
          value={name}
          autoFocus
          maxLength={120}
          placeholder="Acme Coffee — Retail"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <Field label="Website" htmlFor={`${fieldId}-website`} hint="Optional.">
        <Input
          id={`${fieldId}-website`}
          type="url"
          value={website}
          placeholder="https://example.com"
          onChange={(event) => setWebsite(event.target.value)}
        />
      </Field>

      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={busy} disabled={busy || name.trim().length < 2}>
          Create brand
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
