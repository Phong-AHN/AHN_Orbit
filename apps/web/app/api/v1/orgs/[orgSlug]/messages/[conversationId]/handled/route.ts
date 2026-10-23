import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { conversationHandledSchema } from '@/features/messaging/contracts';
import { conversationResourceScope } from '@/features/messaging/route-scope';
import { setConversationHandled } from '@/features/messaging/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; conversationId: string };

/** Mark a conversation dealt with, or put it back (D-107). */
export const POST = withAuth<Params>(
  {
    permission: 'message:reply',
    resource: conversationResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/messages/{conversationId}/handled',
  },
  async ({ request, ctx, params }) => {
    const { handled } = conversationHandledSchema.parse(await request.json());

    return jsonOk({
      conversation: await setConversationHandled(
        ctx,
        params.conversationId,
        handled,
        requestFingerprint(request),
      ),
    });
  },
);
