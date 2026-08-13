import { z } from 'zod';
import { NotFoundError, ValidationError, type TenantContext } from '@orbit/core';
import { serverEnv } from '@orbit/config';
import { withTenant } from '@orbit/db';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { ensureProvidersRegistered } from '@/server/providers';
import { oauthStateCookie } from '@/features/social/oauth-state';
import { startReconnect } from '@/features/social/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; accountId: string };

/**
 * `returnTo` is the only thing a caller may supply.
 *
 * Platform, workspace and brand all come from the account row. There is
 * deliberately no field through which a reconnect could be aimed at a different
 * workspace's brand — the flow's target is a fact about the account, not a
 * request parameter.
 */
const bodySchema = z.object({
  returnTo: z.string().max(512).optional(),
});

async function scope({ params, ctx }: { params: Params; ctx: TenantContext }) {
  const account = await withTenant(ctx, (db) =>
    db.socialAccount.findFirst({
      where: { id: params.accountId, deletedAt: null },
      select: { workspaceId: true, brandId: true },
    }),
  );
  if (!account) throw new NotFoundError('Social account');
  return { workspaceId: account.workspaceId, brandId: account.brandId };
}

/**
 * Begin reconnecting a broken account (T1.7).
 *
 * Returns the authorization URL and sets the single-use state cookie; the
 * browser navigates from there. The existing callback finishes the job — it
 * cannot tell a reconnect from a first connection, and `connectAccounts`
 * recognises the existing row and updates it rather than creating a duplicate.
 *
 * No token material is returned here or anywhere else in this flow.
 */
export const POST = withAuth<Params>(
  {
    permission: 'social_account:reconnect',
    resource: scope,
    name: 'POST /api/v1/orgs/{orgSlug}/social-accounts/{accountId}/reconnect',
  },
  async ({ request, ctx, params, user }) => {
    ensureProvidersRegistered();

    const input = await readJsonBody(request, bodySchema);

    // Only relative paths, so `returnTo` cannot become an open redirect.
    if (input.returnTo && !input.returnTo.startsWith('/')) {
      throw new ValidationError('returnTo must be a relative path', {
        userMessage: 'That return location is not allowed.',
      });
    }

    const account = await withTenant(ctx, (db) =>
      db.socialAccount.findFirst({
        where: { id: params.accountId, deletedAt: null },
        select: { platform: true },
      }),
    );
    if (!account) throw new NotFoundError('Social account');

    const redirectUri = `${serverEnv().APP_URL}/api/v1/social/oauth/${account.platform.toLowerCase()}/callback`;

    const { authorizationUrl, scopes, nonce } = await startReconnect(ctx, {
      socialAccountId: params.accountId,
      userId: user.id,
      redirectUri,
      ...(input.returnTo !== undefined ? { returnTo: input.returnTo } : {}),
    });

    const response = jsonOk({ authorizationUrl, scopes });
    response.cookies.set(oauthStateCookie(nonce));
    return response;
  },
);
