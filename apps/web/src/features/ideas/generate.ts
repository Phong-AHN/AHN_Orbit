import { clock, isUserPrincipal, type Platform, type TenantContext } from '@orbit/core';
import type { AIProvider } from '@orbit/ai';
import type { AuditInput } from '@/server/audit';
import { getCreditStatus, runGeneration } from '@/features/ai/service';
import { listPostAnalytics } from '@/features/analytics/service';
import { engagementOf } from '@/features/analytics/insights';
import type { GenerateIdeasInput } from './contracts';
import { createIdea, listIdeas } from './service';

/**
 * Ideas from the model, saved as suggestions (D-109 §8.1).
 *
 * Grounded on the brand's own material and on what actually did well for it
 * in the last 90 days. Every idea lands as `SUGGESTED` through `createIdea`,
 * with its audit row — nothing here makes a post, and a person accepts or
 * dismisses each one.
 */

const DAY_MS = 24 * 60 * 60_000;

export async function generateIdeas(
  ctx: TenantContext,
  input: GenerateIdeasInput,
  provider: AIProvider,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const now = clock.now();
  const ownOnly =
    isUserPrincipal(ctx.principal) && ctx.principal.organizationRole === 'CONTENT_CREATOR'
      ? ctx.principal.userId
      : undefined;

  const [history, existing] = await Promise.all([
    listPostAnalytics(
      ctx,
      { from: new Date(now.getTime() - 90 * DAY_MS), to: now },
      { brandId: input.brandId, ...(ownOnly ? { authoredBy: ownOnly } : {}), limit: 200 },
    ),
    listIdeas(ctx, { brandId: input.brandId, limit: 100 }),
  ]);

  const topPosts = history
    .map((row) => ({
      text: (row.post.title ? `${row.post.title}: ` : '') + (row.post.body ?? ''),
      engagement: engagementOf(row.reading),
    }))
    .filter((p) => p.engagement !== null && p.text.trim())
    .sort((a, b) => (b.engagement ?? 0) - (a.engagement ?? 0))
    .slice(0, 10);

  const result = await runGeneration(
    { ctx, brandId: input.brandId, operation: 'ideas', correlationId: ctx.correlationId },
    provider,
    (brand) =>
      provider.generateIdeas({
        brand,
        count: input.count,
        theme: input.theme,
        platforms: input.platforms,
        from: input.from,
        to: input.to,
        topPosts,
        existingTopics: existing.filter((i) => i.state !== 'DISMISSED').map((i) => i.topic),
        researchNotes: input.researchNotes,
        correlationId: ctx.correlationId,
      }),
  );

  const saved = [];
  for (const idea of result.value) {
    const row = await createIdea(
      ctx,
      {
        workspaceId: input.workspaceId,
        brandId: input.brandId,
        topic: idea.topic,
        ...(idea.hook ? { hook: idea.hook } : {}),
        ...(idea.platform ? { platform: idea.platform as Platform } : {}),
        ...(idea.format ? { format: idea.format } : {}),
        ...(idea.caption ? { caption: idea.caption } : {}),
        ...(idea.cta ? { cta: idea.cta } : {}),
      },
      fingerprint,
    );
    saved.push({ ...row, reason: idea.reason });
  }

  const credits = await getCreditStatus(ctx);
  return {
    ideas: saved,
    basedOn: { topPosts: topPosts.length, existingIdeas: existing.length },
    bannedTermHits: result.bannedTermHits,
    model: result.model,
    creditsRemaining: credits.remaining ?? null,
  };
}
