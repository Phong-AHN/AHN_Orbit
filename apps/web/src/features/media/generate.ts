import sharp from 'sharp';
import { z } from 'zod';
import { clock, type TenantContext } from '@orbit/core';
import { IMAGE_ASPECT_RATIOS, type AIProvider } from '@orbit/ai';
import { withTenant } from '@orbit/db';
import { putObject } from '@orbit/storage';
import { audit, type AuditInput } from '@/server/audit';
import { getCreditStatus, runGeneration } from '@/features/ai/service';
import { completeMediaUpload, presignMediaUpload } from './service';

/**
 * Generate an image and put it in the media library (D-110).
 *
 * The bytes take exactly the path an upload takes: `presignMediaUpload`
 * reserves the row and checks the plan's storage, the server writes the
 * object, and `completeMediaUpload` sniffs and measures the bytes, marks the
 * asset READY and audits it — so a generated image is held to the same rules
 * as one a person uploaded, and is rejected the same way if it fails them.
 *
 * Stored as **JPEG**, whatever the model returned: Instagram publishes JPEG
 * only, and an image that could go to every platform but one is a trap the
 * person only discovers at publish time. Google's SynthID watermark is in the
 * pixels, so it survives the conversion.
 *
 * The asset is tagged `ai-generated`. Meta and TikTok ask that realistic
 * AI-made images be labelled when published, and the tag is how the person —
 * and the composer — can tell which ones are.
 */

export const AI_GENERATED_TAG = 'ai-generated';

export const generateImageSchema = z.object({
  workspaceId: z.string().uuid(),
  brandId: z.string().uuid(),
  prompt: z.string().trim().min(5).max(1_500),
  aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).default('1:1'),
  /** Only when the image should show words; spelled exactly. */
  textInImage: z.string().trim().max(120).optional(),
});

export type GenerateImageInput = z.infer<typeof generateImageSchema>;

export async function generateImage(
  ctx: TenantContext,
  input: GenerateImageInput,
  provider: AIProvider,
  fingerprint: Pick<AuditInput, 'ip' | 'userAgent'>,
) {
  const result = await runGeneration(
    { ctx, brandId: input.brandId, operation: 'image', correlationId: ctx.correlationId },
    provider,
    (brand) =>
      provider.generateImage({
        prompt: input.prompt,
        aspectRatio: input.aspectRatio,
        textInImage: input.textInImage,
        brand,
        correlationId: ctx.correlationId,
      }),
  );

  const bytes = new Uint8Array(
    await sharp(result.value.bytes)
      // A transparent background would turn black in a JPEG.
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer(),
  );
  const mimeType = 'image/jpeg';
  const stamp = clock.now().toISOString().slice(0, 19).replaceAll(':', '-');
  const reserved = await presignMediaUpload(ctx, {
    workspaceId: input.workspaceId,
    brandId: input.brandId,
    filename: `ai-image-${stamp}.jpg`,
    declaredMimeType: mimeType,
    declaredSizeBytes: bytes.byteLength,
  });

  await putObject({ key: reserved.storageKey, body: bytes, contentType: mimeType });
  const asset = await completeMediaUpload(ctx, reserved.assetId, fingerprint);

  const tagged = await withTenant(ctx, async (db) => {
    const row = await db.mediaAsset.update({
      where: { id: reserved.assetId },
      data: { tags: { push: AI_GENERATED_TAG } },
      select: { id: true, tags: true },
    });
    await audit(db, ctx, {
      action: 'media.ai_generated',
      resourceType: 'MediaAsset',
      resourceId: reserved.assetId,
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      after: {
        model: result.model,
        aspectRatio: input.aspectRatio,
        prompt: input.prompt.slice(0, 500),
      },
      ...fingerprint,
    });
    return row;
  });

  const credits = await getCreditStatus(ctx);
  return {
    asset: { ...asset, tags: tagged.tags },
    model: result.model,
    creditsRemaining: credits.remaining ?? null,
    note: 'AI-generated image, tagged ai-generated. Attach it to a post with its id. Some platforms ask that realistic AI images be labelled as AI-made when published.',
  };
}
