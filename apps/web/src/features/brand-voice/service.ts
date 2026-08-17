import { NotFoundError, isUserPrincipal, type TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { audit, type AuditInput } from '@/server/audit';
import type { BrandContext, UpdateBrandVoiceInput } from './contracts';

/**
 * Brand Brain storage (T4.1, SRS §24).
 *
 * Plain CRUD over text a person wrote. **Nothing here calls a model** — this is
 * the material a generation is grounded in, and keeping the storage of it
 * separate from the use of it is what lets an agency fill in a brand's voice
 * long before anyone turns on AI, and keeps a failure in one from touching the
 * other.
 *
 * `loadBrandContext` is the only door from here into the AI layer, and it is
 * **hard-scoped to one brand id**. That is the isolation §24 asks for: one
 * brand's private context cannot reach another brand's generation, because
 * there is no call shape that would fetch two.
 */

const VOICE_SELECT = {
  id: true,
  brandId: true,
  companyDescription: true,
  productsServices: true,
  targetAudience: true,
  brandVoice: true,
  tone: true,
  preferredTerms: true,
  bannedTerms: true,
  ctas: true,
  website: true,
  exampleContent: true,
  updatedAt: true,
  updatedBy: { select: { id: true, name: true, email: true } },
} as const;

/**
 * The brand's context, or `null` if nobody has written one.
 *
 * `null` rather than an empty object: "not filled in yet" is a state the UI
 * shows differently from "filled in and blank", and flattening the two would
 * lose the prompt to write the first one.
 */
export async function getBrandVoice(ctx: TenantContext, brandId: string) {
  return withTenant(ctx, (db) =>
    db.brandVoice.findFirst({ where: { brandId }, select: VOICE_SELECT }),
  );
}

export async function updateBrandVoice(
  ctx: TenantContext,
  brandId: string,
  input: UpdateBrandVoiceInput,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  // Verified through the scoped client, so a brand from another organization is
  // simply not found — the composite foreign key would refuse it a moment
  // later anyway, but this produces a sentence rather than a constraint error.
  const brand = await withTenant(ctx, (db) =>
    db.brand.findFirst({ where: { id: brandId, deletedAt: null }, select: { workspaceId: true } }),
  );

  if (!brand) throw new NotFoundError('Brand');

  const updatedById = isUserPrincipal(ctx.principal) ? ctx.principal.userId : null;

  return withTenant(ctx, async (db) => {
    const existing = await db.brandVoice.findFirst({ where: { brandId }, select: { id: true } });

    // Explicit find-then-write rather than `upsert`: an upsert targets a unique
    // index directly, so the scoped client's organization predicate has nowhere
    // to attach, and the db layer refuses one for exactly that reason.
    const saved = existing
      ? await db.brandVoice.update({
          where: { id: existing.id },
          data: { ...input, updatedById },
          select: VOICE_SELECT,
        })
      : await db.brandVoice.create({
          data: {
            organizationId: ctx.organizationId,
            brandId,
            ...input,
            updatedById,
          },
          select: VOICE_SELECT,
        });

    await audit(db, ctx, {
      action: existing ? 'brand_voice.updated' : 'brand_voice.created',
      resourceType: 'BrandVoice',
      resourceId: saved.id,
      workspaceId: brand.workspaceId,
      brandId,
      // The fields that changed, never their contents — a brand's positioning
      // is its own business and the audit log is read by more people than the
      // brand page is.
      after: { fields: Object.keys(input).sort() },
      ...fingerprint,
    });

    return saved;
  });
}

/**
 * Assemble one brand's context for a generation.
 *
 * Takes a brand id and returns that brand's material and nothing else. The
 * caller cannot widen it, cannot pass a list, and cannot reach a brand the
 * tenant-scoped client would not return — which is the whole of the §24
 * isolation guarantee expressed as a function signature.
 *
 * Returns `null` when the brand has no Brand Brain. Generation is still
 * possible without one; it is simply ungrounded, and the caller decides
 * whether that is acceptable rather than this pretending there was context.
 */
export async function loadBrandContext(
  ctx: TenantContext,
  brandId: string,
): Promise<BrandContext | null> {
  const brand = await withTenant(ctx, (db) =>
    db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: {
        name: true,
        voice: {
          select: {
            companyDescription: true,
            productsServices: true,
            targetAudience: true,
            brandVoice: true,
            tone: true,
            preferredTerms: true,
            bannedTerms: true,
            ctas: true,
            website: true,
            exampleContent: true,
          },
        },
      },
    }),
  );

  if (!brand) throw new NotFoundError('Brand');
  if (!brand.voice) return null;

  const voice = brand.voice;

  return {
    brandName: brand.name,
    ...(voice.companyDescription ? { companyDescription: voice.companyDescription } : {}),
    ...(voice.productsServices ? { productsServices: voice.productsServices } : {}),
    ...(voice.targetAudience ? { targetAudience: voice.targetAudience } : {}),
    ...(voice.brandVoice ? { brandVoice: voice.brandVoice } : {}),
    ...(voice.tone ? { tone: voice.tone } : {}),
    ...(voice.website ? { website: voice.website } : {}),
    preferredTerms: voice.preferredTerms,
    bannedTerms: voice.bannedTerms,
    ctas: voice.ctas,
    exampleContent: asStringList(voice.exampleContent),
  };
}

/** `exampleContent` is a Json column; anything unexpected in it is discarded. */
function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
