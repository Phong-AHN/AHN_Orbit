import { NextResponse } from 'next/server';
import { NotFoundError, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { ensureProvidersRegistered } from '@/server/providers';
import { disconnectAccount, getAccount } from '@/features/social/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; accountId: string };

/** Scope the permission check to the account's own workspace. */
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

export const GET = withAuth<Params>(
  {
    permission: 'social_account:read',
    resource: scope,
    name: 'GET /api/v1/orgs/{orgSlug}/social-accounts/{accountId}',
  },
  async ({ ctx, params }) => jsonOk({ account: await getAccount(ctx, params.accountId) }),
);

export const DELETE = withAuth<Params>(
  {
    permission: 'social_account:disconnect',
    resource: scope,
    name: 'DELETE /api/v1/orgs/{orgSlug}/social-accounts/{accountId}',
  },
  async ({ request, ctx, params }) => {
    ensureProvidersRegistered();
    await disconnectAccount(ctx, params.accountId, requestFingerprint(request));
    return new NextResponse(null, { status: 204 });
  },
);
