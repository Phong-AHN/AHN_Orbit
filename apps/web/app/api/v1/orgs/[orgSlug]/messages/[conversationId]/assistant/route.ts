import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { requestFingerprint } from '@/server/audit';
import { conversationAssistantSchema } from '@/features/assistant/contracts';
import { conversationResourceScope } from '@/features/messaging/route-scope';
import { listDecisions, setConversationAssistantPaused } from '@/features/assistant/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; conversationId: string };

/** What the assistant has done in this conversation (D-108). */
export const GET = withAuth<Params>(
  {
    permission: 'message:read',
    resource: conversationResourceScope,
    name: 'GET /api/v1/orgs/{orgSlug}/messages/{conversationId}/assistant',
  },
  async ({ ctx, params }) => jsonOk({ decisions: await listDecisions(ctx, params.conversationId) }),
);

/** Keep the assistant out of this conversation, or let it back in. */
export const POST = withAuth<Params>(
  {
    permission: 'message:reply',
    resource: conversationResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/messages/{conversationId}/assistant',
  },
  async ({ request, ctx, params }) => {
    const { paused } = await readJsonBody(request, conversationAssistantSchema);

    return jsonOk({
      conversation: await setConversationAssistantPaused(
        ctx,
        params.conversationId,
        paused,
        requestFingerprint(request),
      ),
    });
  },
);
