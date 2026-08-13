'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardBody } from '@orbit/ui';
import { ApiError } from '@/features/posts/ui/api';
import { confirmAccounts } from '@/features/tenancy/ui/api';

/**
 * The second half of the OAuth flow.
 *
 * The callback stages every account the authorization surfaced as a DISABLED
 * row with sealed credentials; this is where a person says which of them the
 * agency actually manages. Nothing here handles a token — the picker works from
 * ids alone, which is exactly why the staging step exists.
 *
 * Anything left unticked stays staged and is discarded along with its
 * credentials, so over-granting on Facebook's screen is recoverable here rather
 * than something to go and undo at the platform.
 */

export interface StagedAccount {
  id: string;
  displayName: string;
  handle: string | null;
  accountType: string | null;
}

export interface AccountPickerProps {
  orgSlug: string;
  platform: string;
  workspaceId: string;
  brandId: string;
  accounts: StagedAccount[];
  /** Where to land once the accounts are live. */
  doneHref: string;
}

export function AccountPicker({
  orgSlug,
  platform,
  workspaceId,
  brandId,
  accounts,
  doneHref,
}: AccountPickerProps) {
  const router = useRouter();
  // Pre-ticked: someone who granted access to one Page almost always wants it,
  // and the cost of unticking is lower than hunting for why nothing connected.
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(accounts.map((account) => account.id)),
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function confirm() {
    setBusy(true);
    setError(null);

    try {
      await confirmAccounts(orgSlug, {
        platform,
        workspaceId,
        brandId,
        socialAccountIds: [...selected],
      });

      router.replace(doneHref);
      router.refresh();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'We could not finish connecting. Please try again in a moment.',
      );
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">
            Which of these should this brand publish to?
          </legend>

          {accounts.map((account) => (
            <label
              key={account.id}
              className="flex cursor-pointer items-start gap-3 rounded border border-line px-3 py-2 hover:bg-surface-sunken"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selected.has(account.id)}
                disabled={busy}
                onChange={() => toggle(account.id)}
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink">
                  {account.displayName}
                </span>
                <span className="block text-xs text-ink-muted">
                  {account.accountType ?? platform}
                  {account.handle ? ` · ${account.handle}` : ''}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <p className="text-xs text-ink-muted">
          Anything you leave unticked is discarded, along with the access it granted.
        </p>

        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        <Button
          loading={busy}
          disabled={busy || selected.size === 0}
          onClick={() => void confirm()}
        >
          Connect {selected.size} account{selected.size === 1 ? '' : 's'}
        </Button>
      </CardBody>
    </Card>
  );
}
