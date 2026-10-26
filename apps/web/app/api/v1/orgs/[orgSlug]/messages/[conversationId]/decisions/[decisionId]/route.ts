import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { decisionRatingSchema } from '@/features/assistant/contracts';
import { conversationResourceScope } from '@/features/messaging/route-scope';
import { rateDecision } from '@/features/assistant/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; conversationId: string; decisionId: string };

/** A colleague's verdict on something the assistant said (D-108). */
export const POST = withAuth<Params>(
  {
    permission: 'message:reply',
    resource: conversationResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/messages/{conversationId}/decisions/{decisionId}',
  },
  async ({ request, ctx, params }) => {
    const { rating } = await readJsonBody(request, decisionRatingSchema);

    return jsonOk({
      decision: await rateDecision(ctx, params.conversationId, params.decisionId, rating),
    });
  },
);
