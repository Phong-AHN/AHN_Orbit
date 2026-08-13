'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, CardHeader, CardTitle, Field, Input } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';
import { createWorkspace } from './api';
import { TimezoneField } from './timezone-field';

/**
 * A workspace is one client. Its time zone is asked for rather than inherited
 * because scheduling correctness depends on it (SRS §36) and a client in
 * another country is the normal case, not the exception — the organization's
 * zone is only the starting value.
 */
export interface CreateWorkspaceFormProps {
  orgSlug: string;
  /** The organization's zone, as the sensible default. */
  defaultTimezone: string;
}

export function CreateWorkspaceForm({ orgSlug, defaultTimezone }: CreateWorkspaceFormProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [company, setCompany] = React.useState('');
  const [timezone, setTimezone] = React.useState(defaultTimezone);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Add a client workspace
      </Button>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await createWorkspace(orgSlug, {
        name: name.trim(),
        timezone,
        ...(company.trim() ? { clientCompanyName: company.trim() } : {}),
      });

      setName('');
      setCompany('');
      setOpen(false);
      setBusy(false);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'We could not create the workspace. Please try again in a moment.',
      );
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New client workspace</CardTitle>
      </CardHeader>
      <CardBody>
        <form className="space-y-4" onSubmit={(e) => void submit(e)}>
          <Field label="Workspace name" htmlFor="ws-name" required>
            <Input
              id="ws-name"
              value={name}
              autoFocus
              maxLength={120}
              placeholder="Acme Coffee"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field
            label="Client company"
            htmlFor="ws-company"
            hint="Optional. The legal or trading name, if it differs."
          >
            <Input
              id="ws-company"
              value={company}
              maxLength={160}
              onChange={(event) => setCompany(event.target.value)}
            />
          </Field>

          <TimezoneField
            id="ws-timezone"
            value={timezone}
            onChange={setTimezone}
            hint="Scheduled times for this client are read in this zone."
          />

          {error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              loading={busy}
              disabled={busy || name.trim().length < 2}
            >
              Create workspace
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
      </CardBody>
    </Card>
  );
}
