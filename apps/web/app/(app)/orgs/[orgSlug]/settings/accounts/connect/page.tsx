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
 * Facebook and Instagram are Meta and share one app, so connecting either is
 * the same consent dialog with different scopes; what differs is what comes
 * back. TikTok is its own portal, its own app, its own key pair — and, unlike
 * either Meta surface, one authorization yields exactly **one** account.
 */
const PLATFORMS = ['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'THREADS'] as const;
type ConnectablePlatform = (typeof PLATFORMS)[number];

const PLATFORM_LABEL: Record<ConnectablePlatform, string> = {
  FACEBOOK: 'Facebook Page',
  INSTAGRAM: 'Instagram account',
  TIKTOK: 'TikTok account',
  THREADS: 'Threads account',
};

const PLATFORM_ARTICLE: Record<ConnectablePlatform, string> = {
  FACEBOOK: 'a Facebook Page',
  INSTAGRAM: 'an Instagram account',
  TIKTOK: 'a TikTok account',
  THREADS: 'a Threads account',
};

const PLATFORM_NOTE: Record<ConnectablePlatform, string> = {
  FACEBOOK:
    'You will sign in at Facebook and choose which Pages this brand may publish to. Access tokens are exchanged and stored server-side; they never reach your browser.',
  INSTAGRAM:
    'Instagram professional accounts connect through the Facebook Page they are linked to. An account with no linked Page cannot be connected — link it in the Instagram app first.',
  TIKTOK:
    'You will sign in at TikTok with the account itself — there is no Page to go through, and one sign-in connects one account. Access tokens are exchanged and stored server-side; they never reach your browser.',
  THREADS:
    'You will sign in at Threads with the account itself. Threads connections last 60 days and renew themselves while they are in use — one left idle for longer has to be reconnected by hand.',
};

/** The sign-in each platform actually shows, so the button does not mislead. */
const CONTINUE_LABEL: Record<ConnectablePlatform, string> = {
  FACEBOOK: 'Continue with Facebook',
  INSTAGRAM: 'Continue with Facebook',
  TIKTOK: 'Continue with TikTok',
  THREADS: 'Continue with Threads',
};

interface PageProps {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{
    workspaceId?: string;
    brandId?: string;
    connection?: string;
    platform?: string;
    /** Instagram only: which login surface. */
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

  // A Login for Business configuration is what makes the SDK's popup usable;
  // without one, the full-page redirect is the flow — the same one reconnection
  // always uses, so this is a choice of entry point, not of mechanism.
  const env = serverEnv();

  /**
   * Instagram connects with an Instagram username, full stop.
   *
   * The Page-linked path still exists in the provider and still serves every
   * account already connected through it — but it is no longer offered here.
   * Presenting two ways in was the thing that made this screen wrong: the two
   * live in different Meta apps, and picking the one that does not match the
   * app the credentials came from is a failure the person cannot diagnose.
   *
   * The exception is honest rather than defensive: Instagram Login needs its
   * own Meta app, and if that app is not configured, offering it would lead to
   * a dialog that cannot be built. Then, and only then, the Page-linked flow is
   * what remains.
   */
  const instagramLoginConfigured = Boolean(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET);
  const usernameLogin = platform === 'INSTAGRAM' && instagramLoginConfigured;

  /**
   * TikTok needs its own app, and without one there is nothing to sign in to.
   *
   * Offering the button anyway would send somebody to a dialog that cannot be
   * built, and the error would arrive from TikTok's side looking like their
   * problem. Naming the missing variables here points at the one person who can
   * fix it — the same reasoning as the Instagram Login exception above.
   */
  const unconfigured =
    (platform === 'TIKTOK' && !(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET)) ||
    (platform === 'THREADS' && !(env.THREADS_APP_ID && env.THREADS_APP_SECRET));

  const accountsHref = `/orgs/${orgSlug}/settings/accounts`;
  const returnTo = `/orgs/${orgSlug}/settings/accounts/connect?workspaceId=${workspaceId}&brandId=${brandId}&platform=${platform}`;

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
        {...(usernameLogin ? { accountType: 'INSTAGRAM_LOGIN' } : {})}
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

      {unconfigured ? (
        <Empty
          title={`${PLATFORM_LABEL[platform]}s are not set up on this deployment`}
          description={
            platform === 'THREADS'
              ? 'Threads needs its own app credentials — a Threads app issues two id/secret pairs and this wants the Threads one. An administrator has to set THREADS_APP_ID and THREADS_APP_SECRET on both the web app and the worker.'
              : 'TikTok needs its own app, separate from the Meta one. An administrator has to create it at developers.tiktok.com and set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET on both the web app and the worker.'
          }
        />
      ) : staged.length > 0 ? (
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
              : platform === 'TIKTOK'
                ? 'TikTok returned no account for that sign-in. It usually means the permissions were declined at the consent screen.'
                : 'The account you authorized does not administer any Page this brand could publish to.'
          }
          action={startButton('Try a different account')}
        />
      ) : (
        <Card>
          <CardBody className="space-y-4">
            <p className="text-sm text-ink-secondary">
              {usernameLogin
                ? 'You will sign in at Instagram with the account’s own username. No Facebook Page is needed. Access tokens are exchanged and stored server-side; they never reach your browser.'
                : PLATFORM_NOTE[platform]}
            </p>

            {startButton(usernameLogin ? 'Continue with Instagram' : CONTINUE_LABEL[platform])}
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
