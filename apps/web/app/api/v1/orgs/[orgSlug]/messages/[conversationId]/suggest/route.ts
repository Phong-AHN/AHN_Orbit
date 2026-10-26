import { jsonOk } from '@/server/api-response';
import { withAuth } from '@/server/with-auth';
import { conversationResourceScope } from '@/features/messaging/route-scope';
import { suggestReply } from '@/features/assistant/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; conversationId: string };

/**
 * Draft an answer for the person typing (D-108). Nothing is sent: the draft
 * comes back to the composer, to be read, edited and sent as the person.
 */
export const POST = withAuth<Params>(
  {
    permission: 'message:reply',
    resource: conversationResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/messages/{conversationId}/suggest',
  },
  async ({ ctx, params }) => jsonOk({ suggestion: await suggestReply(ctx, params.conversationId) }),
);
