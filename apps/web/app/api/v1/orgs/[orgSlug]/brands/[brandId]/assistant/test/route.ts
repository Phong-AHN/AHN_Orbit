import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { assistantTestSchema } from '@/features/assistant/contracts';
import { brandResourceScope } from '@/features/assistant/route-scope';
import { testAssistant } from '@/features/assistant/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string; brandId: string };

/**
 * Ask the assistant a question as a customer would (D-108). Nothing is sent to
 * anybody; the answer comes back to the page. Costs a credit when the model is
 * asked.
 */
export const POST = withAuth<Params>(
  {
    permission: 'ai_assistant:manage',
    resource: brandResourceScope,
    name: 'POST /api/v1/orgs/{orgSlug}/brands/{brandId}/assistant/test',
  },
  async ({ request, ctx, params }) => {
    const { text } = await readJsonBody(request, assistantTestSchema);
    return jsonOk({ result: await testAssistant(ctx, params.brandId, text) });
  },
);
