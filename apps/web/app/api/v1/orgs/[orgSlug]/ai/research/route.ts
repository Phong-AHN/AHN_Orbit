import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { aiProvider } from '@/server/ai-provider';
import { researchRequestSchema } from '@/features/ai/contracts';
import { getCreditStatus, runGeneration } from '@/features/ai/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { orgSlug: string };

/**
 * Research a topic on the web, with sources (D-109 §8.2).
 *
 * Grounded in Google Search; the sources are the ones the search returned,
 * and an answer with none is refused rather than returned. Only the question
 * leaves Social Square — never a client's posts, messages or documents. What
 * comes back is web content: a suggestion to read, not a fact to publish.
 */
export const POST = withAuth<Params>(
  {
    permission: 'ai:generate',
    resource: async ({ request }) => {
      const body = (await request
        .clone()
        .json()
        .catch(() => ({}))) as { brandId?: unknown };
      return typeof body.brandId === 'string' ? { brandId: body.brandId } : {};
    },
    name: 'POST /api/v1/orgs/{orgSlug}/ai/research',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, researchRequestSchema);
    const provider = aiProvider();

    const result = await runGeneration(
      { ctx, brandId: input.brandId, operation: 'research', correlationId: ctx.correlationId },
      provider,
      (brand) =>
        provider.researchTopic({
          question: input.question,
          brand,
          correlationId: ctx.correlationId,
        }),
    );
    const credits = await getCreditStatus(ctx);

    return jsonOk({
      ...result.value,
      note: 'Web content, summarised by a model. Check the sources before relying on it.',
      model: result.model,
      creditsRemaining: credits.remaining ?? null,
    });
  },
);
