import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { serverEnv } from '@orbit/config';
import { Card, CardBody, Empty, PageHeader, PermissionDenied } from '@orbit/ui';
import { pageCan, requirePageContext } from '@/server/page-context';
import { getBrand } from '@/features/tenancy/service';
import { listAccounts } from '@/features/social/service';
import { AccountPicker } from '@/features/social/ui/account-picker';
import { ConnectStartButton } from '@/features/social/ui/connect-start-button';
import { FacebookConnectButton } from '@/features/social/ui/facebook-connect-button';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Connect an account' };

/**
 * Platforms with a working adapter.
 *
 * Both are Meta and share one app, so connecting either is the same consent
 * dialog with different scopes. What differs is what comes back: a Facebook
 * Page, or an Instagram professional account reached *through* a Page.
 */
const PLATFORMS = ['FACEBOOK', 'INSTAGRAM'] as const;
type ConnectablePlatform = (typeof PLATFORMS)[number];

const PLATFORM_LABEL: Record<ConnectablePlatform, string> = {
  FACEBOOK: 'Facebook Page',
  INSTAGRAM: 'Instagram account',
};

const PLATFORM_ARTICLE: Record<ConnectablePlatform, string> = {
  FACEBOOK: 'a Facebook Page',
  INSTAGRAM: 'an Instagram account',
};

const PLATFORM_NOTE: Record<ConnectablePlatform, string> = {
  FACEBOOK:
    'You will sign in at Facebook and choose which Pages this brand may publish to. Access tokens are exchanged and stored server-side; they never reach your browser.',
  INSTAGRAM:
    'Instagram professional accounts connect through the Facebook Page they are linked to. An account with no linked Page cannot be connected — link it in the Instagram app first.',
};

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{
    workspaceId?: string;
    brandId?: string;
    connection?: string;
    platform?: string;
  }>;
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
  const { workspaceId, brandId, connection, platform: platformParam } = await searchParams;

  const platform: ConnectablePlatform = (PLATFORMS as readonly string[]).includes(
    (platformParam ?? '').toUpperCase(),
  )
    ? ((platformParam as string).toUpperCase() as ConnectablePlatform)
    : 'FACEBOOK';
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
    (account) => account.status === 'DISABLED' && account.platform === platform,
  );

  const accountsHref = `/orgs/${orgSlug}/settings/accounts`;
  const returnTo = `/orgs/${orgSlug}/settings/accounts/connect?workspaceId=${workspaceId}&brandId=${brandId}&platform=${platform}`;

  // A Login for Business configuration is what makes the SDK's popup usable;
  // without one, the full-page redirect is the flow — the same one reconnection
  // always uses, so this is a choice of entry point, not of mechanism.
  const env = serverEnv();
  const sdk =
    platform === 'FACEBOOK' && env.NEXT_PUBLIC_FACEBOOK_CONFIG_ID && env.FACEBOOK_APP_ID
      ? {
          appId: env.FACEBOOK_APP_ID,
          configId: env.NEXT_PUBLIC_FACEBOOK_CONFIG_ID,
          graphVersion: env.FACEBOOK_GRAPH_VERSION,
        }
      : undefined;

  const startButton = (label: string) =>
    sdk ? (
      <FacebookConnectButton
        orgSlug={orgSlug}
        workspaceId={workspaceId}
        brandId={brandId}
        appId={sdk.appId}
        configId={sdk.configId}
        graphVersion={sdk.graphVersion}
        pickerHref={returnTo}
      />
    ) : (
      <ConnectStartButton
        orgSlug={orgSlug}
        platform={platform}
        workspaceId={workspaceId}
        brandId={brandId}
        returnTo={returnTo}
        label={label}
      />
    );

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-10">
      <PageHeader
        eyebrow={organization.name}
        title={`Connect ${PLATFORM_ARTICLE[platform]} to ${brand.name}`}
        description="Posts publish to the accounts connected to a brand."
      />

      {staged.length > 0 ? (
        <AccountPicker
          orgSlug={orgSlug}
          platform={platform}
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
          title={`No ${PLATFORM_LABEL[platform]}s were returned`}
          description={
            platform === 'INSTAGRAM'
              ? 'The account you authorized administers no Page with an Instagram professional account linked to it.'
              : 'The account you authorized does not administer any Page this brand could publish to.'
          }
          action={startButton('Try a different account')}
        />
      ) : (
        <Card>
          <CardBody className="space-y-4">
            <p className="text-sm text-ink-secondary">{PLATFORM_NOTE[platform]}</p>

            {/* Both go through Facebook's dialog — Instagram included, because
                that is where the Page grant comes from. */}
            {startButton('Continue with Facebook')}
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
