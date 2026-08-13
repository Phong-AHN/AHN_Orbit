import Link from 'next/link';
import { ReconnectButton } from './reconnect-button';

/**
 * The banner that stops a broken connection being a silent failure (T1.7, SRS §14).
 *
 * Deliberately not dismissible. A dismissible warning about something that is
 * still broken trains people to dismiss it, and the cost of getting this wrong
 * is a client's posts quietly not going out for a week.
 *
 * It renders nothing at all when everything is healthy — no "all good" strip —
 * because a banner that is always present is one nobody reads.
 */

export interface BrokenAccount {
  id: string;
  displayName: string;
  healthError: string | null;
}

export interface NeedsReconnectBannerProps {
  orgSlug: string;
  accounts: readonly BrokenAccount[];
  /** Whether to offer the fix. A reader without the right is still told. */
  canReconnect: boolean;
  /** Where the OAuth callback should return the browser. */
  returnTo?: string;
}

export function NeedsReconnectBanner({
  orgSlug,
  accounts,
  canReconnect,
  returnTo,
}: NeedsReconnectBannerProps) {
  if (accounts.length === 0) return null;

  return (
    <section
      role="alert"
      aria-labelledby="needs-reconnect-heading"
      className="rounded-lg border border-danger/40 bg-danger-soft px-4 py-3.5"
    >
      <h2 id="needs-reconnect-heading" className="text-sm font-semibold text-danger">
        {accounts.length === 1
          ? '1 account needs reconnecting'
          : `${accounts.length} accounts need reconnecting`}
      </h2>

      <p className="mt-1 text-sm text-ink-secondary">
        Posts scheduled for {accounts.length === 1 ? 'this account' : 'these accounts'} are waiting
        and will not publish until the connection is restored. Their scheduled times are kept.
      </p>

      <ul className="mt-3 space-y-2.5">
        {accounts.map((account) => (
          <li key={account.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 text-sm text-ink">
              <span className="font-medium">{account.displayName}</span>
              {account.healthError ? (
                <span className="text-ink-muted"> — {account.healthError}</span>
              ) : null}
            </span>

            {canReconnect ? (
              <ReconnectButton
                orgSlug={orgSlug}
                accountId={account.id}
                accountName={account.displayName}
                {...(returnTo !== undefined ? { returnTo } : {})}
              />
            ) : null}
          </li>
        ))}
      </ul>

      {!canReconnect ? (
        <p className="mt-3 text-xs text-ink-muted">
          Ask an organization admin or the account manager to reconnect{' '}
          {accounts.length === 1 ? 'it' : 'them'}.
        </p>
      ) : (
        <p className="mt-3 text-xs text-ink-muted">
          <Link href={`/orgs/${orgSlug}/settings/accounts`} className="hover:underline">
            Manage connected accounts →
          </Link>
        </p>
      )}
    </section>
  );
}
