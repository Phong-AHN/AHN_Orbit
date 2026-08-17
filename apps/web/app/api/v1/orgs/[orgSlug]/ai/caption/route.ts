import { newCorrelationId } from '@orbit/core';
import { currentCorrelationId } from '@orbit/observability';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { aiProvider } from '@/server/ai-provider';
import { captionRequestSchema } from '@/features/ai/contracts';
import { getCreditStatus, runGeneration } from '@/features/ai/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * A suggested caption (SRS §24, docs/API.md §2.10).
 *
 * Returns a **suggestion object** and nothing else. It does not write to a
 * post, it does not create one, and there is no path from here to publishing
 * (§25) — the caller decides what to do with the text, and a person has to act
 * for anything to change.
 *
 * `bannedTermHits` travels with the result as a **warning**. The person writing
 * knows the context better than a word list does, so the suggestion is returned
 * either way and the surface says what it found.
 */
export const POST = withAuth<Params>(
  {
    permission: 'ai:generate',
    resource: async ({ request }) => {
      const body = await request
        .clone()
        .json()
        .catch(() => ({}));
      const brandId = (body as { brandId?: unknown }).brandId;
      return typeof brandId === 'string' ? { brandId } : {};
    },
    name: 'POST /api/v1/orgs/{orgSlug}/ai/caption',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, captionRequestSchema);
    const provider = aiProvider();

    const result = await runGeneration(
      {
        ctx,
        brandId: input.brandId,
        operation: 'caption',
        correlationId: currentCorrelationId() ?? newCorrelationId(),
      },
      provider,
      (brand) =>
        provider.generateCaption({
          brand,
          intent: input.intent,
          ...(input.platform ? { platform: input.platform } : {}),
          ...(input.maxLength ? { maxLength: input.maxLength } : {}),
          correlationId: currentCorrelationId() ?? newCorrelationId(),
        }),
    );

    // The balance travels with the result rather than living behind
    // `ai:view_usage`: whoever just spent a credit is exactly the person who
    // needs to know how many are left, and that is not the same question as
    // "what is this organization spending" (D-077).
    const credits = await getCreditStatus(ctx);

    return jsonOk({
      suggestion: result.value,
      model: result.model,
      bannedTermHits: result.bannedTermHits,
      creditsRemaining: credits.remaining ?? null,
    });
  },
);
