import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { messageReplySchema } from '@/features/messaging/contracts';
import { conversationResourceScope } from '@/features/messaging/route-scope';
import { replyToConversation } from '@/features/messaging/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; conversationId: string };

/**
 * Answer a private message, as the brand (D-107).
 *
 * Addressed by Orbit's conversation id, never the platform's person id. A body
 * carrying a recipient would let a caller message anybody the Page's token can
 * reach — which is everyone who ever wrote to it, in any client's account.
 */
export const POST = withAuth<Params>(
  {
    permission: 'message:reply',
    resource: conversationResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/messages/{conversationId}/reply',
  },
  async ({ request, ctx, params }) => {
    const input = messageReplySchema.parse(await request.json());

    return jsonOk({
      message: await replyToConversation(
        ctx,
        params.conversationId,
        input,
        requestFingerprint(request),
      ),
    });
  },
);
