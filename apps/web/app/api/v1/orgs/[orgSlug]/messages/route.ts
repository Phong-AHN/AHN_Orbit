import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { listConversations, waitingConversationCount } from '@/features/messaging/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * The private-message inbox (D-107).
 *
 * No route-level permission: `message:read` is brand-scoped for two roles, and
 * an empty-resource check would refuse exactly them. The service gates on
 * `canSomewhere` and narrows the query to the caller's workspaces.
 */
export const GET = withAuth<Params>(
  { name: 'GET /api/v1/orgs/{orgSlug}/messages' },
  async ({ request, ctx }) => {
    const waitingOnly = new URL(request.url).searchParams.get('view') !== 'all';

    const [conversations, waiting] = await Promise.all([
      listConversations(ctx, { waitingOnly }),
      waitingConversationCount(ctx),
    ]);

    return jsonOk({ conversations, waiting });
  },
);
