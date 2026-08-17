import { newCorrelationId } from '@orbit/core';
import { currentCorrelationId } from '@orbit/observability';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { aiProvider } from '@/server/ai-provider';
import { hashtagRequestSchema } from '@/features/ai/contracts';
import { getCreditStatus, runGeneration } from '@/features/ai/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/** Suggested hashtags (SRS §24). A list to choose from, not one to apply. */
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
    name: 'POST /api/v1/orgs/{orgSlug}/ai/hashtags',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, hashtagRequestSchema);
    const provider = aiProvider();
    const correlationId = currentCorrelationId() ?? newCorrelationId();

    const result = await runGeneration(
      { ctx, brandId: input.brandId, operation: 'hashtags', correlationId },
      provider,
      (brand) =>
        provider.generateHashtags({
          brand,
          text: input.text,
          count: input.count,
          ...(input.platform ? { platform: input.platform } : {}),
          correlationId,
        }),
    );

    // The balance travels with the result rather than living behind
    // `ai:view_usage`: whoever just spent a credit is exactly the person who
    // needs to know how many are left, and that is not the same question as
    // "what is this organization spending" (D-077).
    const credits = await getCreditStatus(ctx);

    return jsonOk({
      hashtags: result.value,
      model: result.model,
      bannedTermHits: result.bannedTermHits,
      creditsRemaining: credits.remaining ?? null,
    });
  },
);
