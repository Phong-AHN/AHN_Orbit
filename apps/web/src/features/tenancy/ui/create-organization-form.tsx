'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody, Field, Input } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';
import { createOrganization } from './api';
import { TimezoneField, browserTimezone } from './timezone-field';

/**
 * The first screen of a brand-new account.
 *
 * The slug is not asked for: it is derived server-side from the name, because
 * a caller-chosen slug is a chance to squat on another tenant's URL
 * (docs/DECISIONS.md, tenancy contracts). So this collects two fields and gets
 * out of the way.
 *
 * On success it navigates to the new organization's own workspace setup rather
 * than a dashboard, because an organization with no client workspace has
 * nothing a dashboard could show.
 */
export function CreateOrganizationForm() {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [timezone, setTimezone] = React.useState(browserTimezone);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { organization } = await createOrganization({ name: name.trim(), timezone });

      // Kept busy across the navigation: the form must not look ready again
      // while the next page is still loading.
      router.replace(`/orgs/${organization.slug}/settings/workspaces?created=organization`);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'We could not create the organization. Please try again in a moment.',
      );
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <form className="space-y-5" onSubmit={(e) => void submit(e)}>
          <Field
            label="Agency name"
            htmlFor="org-name"
            required
            hint="Shown to your team. You can change it later."
          >
            <Input
              id="org-name"
              name="name"
              value={name}
              autoFocus
              maxLength={120}
              placeholder="Northlight Studio"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <TimezoneField
            id="org-timezone"
            value={timezone}
            onChange={setTimezone}
            hint="The default for new client workspaces. Each workspace can override it."
          />

          {error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}

          <Button type="submit" loading={busy} disabled={busy || name.trim().length < 2}>
            Create organization
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
