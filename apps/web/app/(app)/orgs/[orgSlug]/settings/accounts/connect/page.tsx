import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardBody, Empty, PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { getBrand } from '@/features/tenancy/service';
import { listAccounts } from '@/features/social/service';
import { AccountPicker } from '@/features/social/ui/account-picker';
import { ConnectStartButton } from '@/features/social/ui/connect-start-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Connect an account' };

/** The only platform with a working adapter today (docs/BUILD-PLAN.md, Phase 1). */
const PLATFORM = 'FACEBOOK';

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ workspaceId?: string; brandId?: string; connection?: string }>;
}

/**
 * Both ends of the OAuth flow, on one URL.
 *
 * Before: a button that asks the server for an authorization URL. After: the
 * picker, because the callback returns the browser here with
 * `connection=select-accounts` and the discovered accounts already staged as
 * DISABLED rows.
 *
 * One page rather than two because the state that distinguishes them is
 * server-side and observable — whether this brand has staged rows — so a
 * refresh, a back button, or an abandoned flow resumed an hour later all land
 * somewhere correct instead of on a step that no longer applies.
 */
export default async function ConnectAccountPage({ params, searchParams }: PageProps) {
  const { orgSlug } = await params;
  const { workspaceId, brandId, connection } = await searchParams;
  const { ctx, organization } = await requirePageContext(orgSlug);

  if (!brandId || !workspaceId) notFound();

  if (!pageCan(ctx, 'social_account:connect', { workspaceId })) {
    return (
      <main id="main" className="mx-auto max-w-2xl px-6 py-10">
        <PermissionDenied action="connect social accounts" />
      </main>
    );
  }

  // Scoped, so a brand from another tenant — or one not in the named workspace
  // — is simply not found. The API re-checks this; it is not trusted from here.
  const brand = await getBrand(ctx, brandId);
  if (brand.workspaceId !== workspaceId) notFound();

  const accounts = await listAccounts(ctx, { workspaceId, brandId });
  const staged = accounts.filter(
    (account) => account.status === 'DISABLED' && account.platform === PLATFORM,
  );

  const accountsHref = `/orgs/${orgSlug}/settings/accounts`;
  const returnTo = `/orgs/${orgSlug}/settings/accounts/connect?workspaceId=${workspaceId}&brandId=${brandId}`;

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title={`Connect a Page to ${brand.name}`}
        description="Posts publish to the accounts connected to a brand."
      />

      {staged.length > 0 ? (
        <AccountPicker
          orgSlug={orgSlug}
          platform={PLATFORM}
          workspaceId={workspaceId}
          brandId={brandId}
          accounts={staged.map((account) => ({
            id: account.id,
            displayName: account.displayName,
            handle: account.handle,
            accountType: account.accountType,
          }))}
          doneHref={accountsHref}
        />
      ) : connection === 'select-accounts' ? (
        <Empty
          title="Facebook returned no Pages"
          description="The account you authorized does not administer any Page this brand could publish to. Try again with an account that does."
          action={
            <ConnectStartButton
              orgSlug={orgSlug}
              platform={PLATFORM}
              workspaceId={workspaceId}
              brandId={brandId}
              returnTo={returnTo}
              label="Try a different account"
            />
          }
        />
      ) : (
        <Card>
          <CardBody className="space-y-4">
            <p className="text-sm text-ink-secondary">
              You will sign in at Facebook and choose which Pages this brand may publish to. Access
              tokens are exchanged and stored server-side; they never reach your browser.
            </p>

            <ConnectStartButton
              orgSlug={orgSlug}
              platform={PLATFORM}
              workspaceId={workspaceId}
              brandId={brandId}
              returnTo={returnTo}
              label="Continue with Facebook"
            />
          </CardBody>
        </Card>
      )}

      <p className="mt-6 text-sm text-ink-muted">
        <Link href={accountsHref} className="hover:underline">
          Back to connected accounts
        </Link>
      </p>
    </main>
  );
}
