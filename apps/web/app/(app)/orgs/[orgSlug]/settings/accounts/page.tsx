import type { Metadata } from 'next';
import Link from 'next/link';
import type { SocialAccountStatus } from '@orbit/core';
import {
  Badge,
  Card,
  CardBody,
  Empty,
  PageHeader,
  PermissionDenied,
  buttonClassName,
} from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { listAccounts } from '@/features/social/service';
import { NeedsReconnectBanner } from '@/features/social/ui/needs-reconnect-banner';
import { ReconnectButton } from '@/features/social/ui/reconnect-button';
import { DisconnectButton } from '@/features/social/ui/disconnect-button';
import {
  ACCOUNT_STATUS_HINT,
  ACCOUNT_STATUS_LABEL,
  ACCOUNT_STATUS_TONE,
  canReconnect,
} from '@/features/social/ui/status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Connected accounts' };

interface PageProps {
  params: Promise<{ orgSlug: string }>;
}

/**
 * Connected accounts and their health (SRS §14, T1.7).
 *
 * Sorted so anything broken is at the top, because this page exists to answer
 * one question — "is anything about to stop publishing?" — and a healthy account
 * is not news. The health verdict shown is the stored one; probing every account
 * on page load would spend a provider call per render, and the hourly sweep plus
 * the publish path already keep it current.
 */
export default async function AccountsPage({ params }: PageProps) {
  const { orgSlug } = await params;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!pageCan(ctx, 'social_account:read')) {
    return (
      <main id="main" className="mx-auto max-w-4xl px-6 py-10">
        <PermissionDenied action="see connected accounts" />
      </main>
    );
  }

  const mayReconnect = pageCan(ctx, 'social_account:reconnect');
  const mayDisconnect = pageCan(ctx, 'social_account:disconnect');
  const accounts = await listAccounts(ctx);

  // A staged row mid-OAuth is not a connection anyone has made yet.
  const visible = accounts.filter((account) => account.status !== 'DISABLED');
  const broken = visible.filter((account) => account.status === 'NEEDS_RECONNECT');

  const ordered = [...visible].sort((a, b) => {
    const rank = (status: SocialAccountStatus) => (status === 'NEEDS_RECONNECT' ? 0 : 1);
    return rank(a.status) - rank(b.status) || a.displayName.localeCompare(b.displayName);
  });

  const returnTo = `/orgs/${orgSlug}/settings/accounts`;

  return (
    <main id="main" className="mx-auto max-w-4xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title="Connected accounts"
        description="The social accounts this organization publishes to, and whether they are working."
        actions={
          pageCan(ctx, 'social_account:connect') ? (
            <Link
              href={`/orgs/${orgSlug}/settings/workspaces`}
              className={buttonClassName({ variant: 'secondary', size: 'sm' })}
            >
              Connect an account
            </Link>
          ) : null
        }
      />

      {broken.length > 0 ? (
        <div className="mt-6">
          <NeedsReconnectBanner
            orgSlug={orgSlug}
            accounts={broken}
            canReconnect={mayReconnect}
            returnTo={returnTo}
          />
        </div>
      ) : null}

      <section className="mt-6" aria-labelledby="accounts-heading">
        <h2 id="accounts-heading" className="sr-only">
          Accounts
        </h2>

        {ordered.length === 0 ? (
          <Empty
            title="No accounts connected"
            description="Connect a Facebook Page to start scheduling and publishing posts. Accounts connect to a brand, so pick one first."
            action={
              pageCan(ctx, 'social_account:connect') ? (
                <Link href={`/orgs/${orgSlug}/settings/workspaces`} className={buttonClassName()}>
                  Choose a brand
                </Link>
              ) : null
            }
          />
        ) : (
          <ul className="space-y-2.5">
            {ordered.map((account) => (
              <li key={account.id}>
                <Card
                  className={account.status === 'NEEDS_RECONNECT' ? 'border-danger/40' : undefined}
                >
                  <CardBody className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-ink">
                          {account.displayName}
                        </span>
                        <Badge tone={ACCOUNT_STATUS_TONE[account.status]}>
                          {ACCOUNT_STATUS_LABEL[account.status]}
                        </Badge>
                      </div>

                      <p className="mt-1 text-xs text-ink-muted">
                        {account.platform}
                        {account.handle ? ` · ${account.handle}` : ''}
                        {account.healthCheckedAt
                          ? ` · checked ${formatWhen(account.healthCheckedAt)}`
                          : ' · never checked'}
                      </p>

                      {account.healthError ? (
                        <p className="mt-1.5 text-sm text-danger">{account.healthError}</p>
                      ) : (
                        renderHint(account.status)
                      )}
                    </div>

                    <div className="flex shrink-0 items-start gap-1.5">
                      {mayReconnect && canReconnect(account.status) ? (
                        <ReconnectButton
                          orgSlug={orgSlug}
                          accountId={account.id}
                          accountName={account.displayName}
                          returnTo={returnTo}
                          variant={account.status === 'NEEDS_RECONNECT' ? 'primary' : 'secondary'}
                        />
                      ) : null}

                      {/* Offered whatever the health verdict says. A dead
                          connection is the case where somebody most wants to be
                          rid of it, so hiding this behind "healthy only" would
                          withhold it exactly when it is needed. */}
                      {mayDisconnect ? (
                        <DisconnectButton
                          orgSlug={orgSlug}
                          accountId={account.id}
                          accountName={account.displayName}
                          platform={account.platform}
                        />
                      ) : null}
                    </div>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function renderHint(status: SocialAccountStatus) {
  const hint = ACCOUNT_STATUS_HINT[status];
  if (!hint) return null;
  return <p className="mt-1.5 text-sm text-ink-muted">{hint}</p>;
}

/** Coarse on purpose: the exact second of a health check is never the question. */
function formatWhen(value: Date): string {
  return value.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
