import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { conversationResourceScope } from '@/features/messaging/route-scope';
import { getConversation } from '@/features/messaging/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; conversationId: string };

/** One conversation, with whether a reply may be sent now (D-107). */
export const GET = withAuth<Params>(
  {
    permission: 'message:read',
    resource: conversationResourceScope,
    name: 'GET /api/v1/orgs/{orgSlug}/messages/{conversationId}',
  },
  async ({ ctx, params }) => jsonOk(await getConversation(ctx, params.conversationId)),
);
