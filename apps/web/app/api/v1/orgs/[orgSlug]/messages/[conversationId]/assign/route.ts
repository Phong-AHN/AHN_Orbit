import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { conversationAssignSchema } from '@/features/messaging/contracts';
import { conversationResourceScope } from '@/features/messaging/route-scope';
import { assignConversation } from '@/features/messaging/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; conversationId: string };

/** Hand a conversation to a colleague, or take it back (D-107). */
export const POST = withAuth<Params>(
  {
    permission: 'message:reply',
    resource: conversationResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/messages/{conversationId}/assign',
  },
  async ({ request, ctx, params }) => {
    const input = conversationAssignSchema.parse(await request.json());

    return jsonOk({
      conversation: await assignConversation(
        ctx,
        params.conversationId,
        input,
        requestFingerprint(request),
      ),
    });
  },
);
