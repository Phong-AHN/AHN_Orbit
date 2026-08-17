import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { fetchTikTokCreatorOptions, tiktokAccountScope } from '@/features/social/tiktok';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; accountId: string };

/**
 * What this TikTok creator currently allows.
 *
 * Guarded by `post:create` rather than `social_account:read`: the only caller
 * is the composer, and the question it answers — "who may see this post?" — is
 * a composing decision, not an account-settings one.
 *
 * The response carries no avatar and no token. It is the creator's *options*,
 * which is all the composer needs to offer an honest choice.
 */
export const GET = withAuth<Params>(
  {
    permission: 'post:create',
    // `post:create` is BRAND-scoped. Without this every Content Creator with a
    // grant narrowed to one client is denied (D-069).
    resource: tiktokAccountScope,
    name: 'GET /api/v1/orgs/{orgSlug}/social-accounts/{accountId}/tiktok-creator',
  },
  async ({ ctx, params }) => jsonOk(await fetchTikTokCreatorOptions(ctx, params.accountId)),
);
