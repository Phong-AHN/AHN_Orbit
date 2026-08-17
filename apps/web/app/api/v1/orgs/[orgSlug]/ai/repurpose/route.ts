import { newCorrelationId } from '@orbit/core';
import { currentCorrelationId } from '@orbit/observability';
import { capabilitiesFor } from '@orbit/providers';
import { jsonOk } from '@/server/api-response';
import { readJsonBody, withAuth } from '@/server/with-auth';
import { aiProvider } from '@/server/ai-provider';
import { adaptRequestSchema } from '@/features/ai/contracts';
import { getCreditStatus, runGeneration } from '@/features/ai/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { orgSlug: string };

/**
 * Rework existing content for another platform (SRS §25, docs/API.md §2.10).
 *
 * **The constraints come from the capability descriptor, never from the
 * client.** The target's character cap and whether it renders links at all are
 * facts about the platform that the descriptor already records and verifies
 * (SRS §46.I) — asking the browser for them would let a caller claim Instagram
 * supports links, and produce a caption telling a client's followers to click
 * something that is not there.
 *
 * A suggestion like every other generation: it writes to no post, and the
 * person decides whether to keep it.
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
    name: 'POST /api/v1/orgs/{orgSlug}/ai/repurpose',
  },
  async ({ request, ctx }) => {
    const input = await readJsonBody(request, adaptRequestSchema);
    const provider = aiProvider();
    const correlationId = currentCorrelationId() ?? newCorrelationId();

    // The target platform's own limits. `accountType` is left null: these two
    // properties do not vary by account type on either Meta surface, and the
    // descriptor's default is the conservative one.
    const target = capabilitiesFor(input.targetPlatform, null);

    const result = await runGeneration(
      {
        ctx,
        brandId: input.brandId,
        operation: `repurpose:${input.targetPlatform.toLowerCase()}`,
        correlationId,
      },
      provider,
      (brand) =>
        provider.adaptForPlatform({
          brand,
          text: input.text,
          targetPlatform: input.targetPlatform,
          ...(input.sourcePlatform ? { sourcePlatform: input.sourcePlatform } : {}),
          maxLength: target.text.maxLength,
          supportsLinks: target.link.supported,
          correlationId,
        }),
    );

    const credits = await getCreditStatus(ctx);

    return jsonOk({
      suggestion: result.value,
      model: result.model,
      bannedTermHits: result.bannedTermHits,
      creditsRemaining: credits.remaining ?? null,
      // Stated back so the UI can explain *why* the text changed shape, rather
      // than leaving a shortened caption looking like the model lost content.
      constraints: {
        targetPlatform: input.targetPlatform,
        maxLength: target.text.maxLength,
        supportsLinks: target.link.supported,
      },
    });
  },
);
