import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { fetchPinterestBoards, pinterestAccountScope } from '@/features/social/pinterest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; accountId: string };

/**
 * The boards this Pinterest account can pin to.
 *
 * Guarded by `post:create` rather than `social_account:read`, for the same
 * reason as the TikTok creator route: the only caller is the composer, and
 * "where does this pin go?" is a composing decision rather than an
 * account-settings one.
 *
 * The response carries no token and no secret boards — Orbit does not hold the
 * scope that would return them.
 */
export const GET = withAuth<Params>(
  {
    permission: 'post:create',
    // `post:create` is BRAND-scoped. Without this every Content Creator with a
    // grant narrowed to one client is denied (D-069).
    resource: pinterestAccountScope,
    name: 'GET /api/v1/orgs/{orgSlug}/social-accounts/{accountId}/pinterest-boards',
  },
  async ({ ctx, params }) => jsonOk({ boards: await fetchPinterestBoards(ctx, params.accountId) }),
);
