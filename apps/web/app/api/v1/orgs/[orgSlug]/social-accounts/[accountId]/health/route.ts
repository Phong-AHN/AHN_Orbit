import { NotFoundError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { capabilitiesFor } from '@orbit/providers';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { ensureProvidersRegistered } from '@/server/providers';
import { checkAccountHealth, getAccount } from '@/features/social/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; accountId: string };

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
 * Probe the account against its platform and record the verdict.
 *
 * Also returns the capability descriptor, since the composer needs it for the
 * same account and this saves a round trip.
 */
export const GET = withAuth<Params>(
  {
    permission: 'social_account:read',
    resource: scope,
    name: 'GET /api/v1/orgs/{orgSlug}/social-accounts/{accountId}/health',
  },
  async ({ ctx, params }) => {
    ensureProvidersRegistered();

    const account = await getAccount(ctx, params.accountId);
    const health = await checkAccountHealth(ctx, params.accountId);

    return jsonOk({
      health,
      capabilities: capabilitiesFor(account.platform, account.accountType),
    });
  },
);
