import {
  ConflictError,
  NotFoundError,
  ProviderAuthenticationError,
  contentHash as computeContentHash,
  type Platform,
  type TenantContext,
} from '@orbit/core';
import { withTenant } from '@orbit/db';
import { logError } from '@orbit/observability';
import { ensureConvertedImage, presignDownload } from '@orbit/storage';
import {
  capabilitiesFor,
  isConvertibleImageFormat,
  resolveThreadDraft,
  type DecryptedCredential,
  type PublishMedia,
  type VariantDraft,
} from '@orbit/providers';
import { freshenCredential, openCredential } from '../credentials.js';

/**
 * Everything a publish needs, resolved at publish time (SRS §13).
 *
 * Resolved **now**, not embedded in the job payload, for three reasons:
 *
 *   • a job queued before an edit must not publish the stale copy;
 *   • credentials must never sit in Redis;
 *   • signed media URLs are short-lived by design, so one minted at schedule
 *     time would likely have expired by the time it was used.
 *
 * Everything here goes through the **tenant-scoped** client built from the
 * subject row's own organization (decision D-021), so a job cannot reach across
 * tenants even if its payload asked to.
 */

export interface PublishSubject {
  variantId: string;
  postId: string;
  workspaceId: string;
  brandId: string;
  socialAccountId: string;
  platform: Platform;
  accountType: string | null;
  externalId: string;
  credential: DecryptedCredential;
  draft: VariantDraft;
  media: PublishMedia[];
  /** What an earlier attempt recorded, for adapters that can resume. */
  previousRef?: Record<string, unknown> | undefined;
  contentHash: string;
}

/** How long a media URL handed to a provider stays valid. */
const MEDIA_URL_TTL_SECONDS = 900;

export async function loadPublishSubject(
  ctx: TenantContext,
  variantId: string,
): Promise<PublishSubject> {
  const resolved = await withTenant(ctx, async (db) => {
    const variant = await db.postVariant.findFirst({
      where: { id: variantId, deletedAt: null },
      select: {
        id: true,
        postId: true,
        platform: true,
        body: true,
        linkUrl: true,
        hashtags: true,
        mentions: true,
        firstComment: true,
        platformOptions: true,
        contentHash: true,
        providerRef: true,
        socialAccountId: true,
        socialAccount: {
          select: {
            id: true,
            externalId: true,
            accountType: true,
            status: true,
            displayName: true,
          },
        },
        media: {
          orderBy: { position: 'asc' },
          select: {
            altText: true,
            mediaAsset: {
              select: {
                id: true,
                kind: true,
                mimeType: true,
                sizeBytes: true,
                width: true,
                height: true,
                durationMs: true,
                frameRate: true,
                peakFrameRate: true,
                storageKey: true,
                status: true,
              },
            },
          },
        },
        post: {
          select: {
            id: true,
            body: true,
            workspaceId: true,
            brandId: true,
            media: {
              where: { postVariantId: null },
              orderBy: { position: 'asc' },
              select: {
                altText: true,
                mediaAsset: {
                  select: {
                    id: true,
                    kind: true,
                    mimeType: true,
                    sizeBytes: true,
                    width: true,
                    height: true,
                    durationMs: true,
                    frameRate: true,
                    peakFrameRate: true,
                    storageKey: true,
                    status: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!variant) throw new NotFoundError('Post variant');

    // An account that lost its authorization cannot publish, and finding out
    // here — before the call — turns a provider auth error into a clear one.
    if (variant.socialAccount.status !== 'ACTIVE') {
      throw new ProviderAuthenticationError(
        `Account ${variant.socialAccount.id} is ${variant.socialAccount.status}`,
        {
          userMessage: `${variant.socialAccount.displayName} needs to be reconnected before it can publish.`,
        },
      );
    }

    const credentialRow = await db.socialCredential.findFirst({
      where: { socialAccountId: variant.socialAccountId },
    });
    if (!credentialRow) throw new NotFoundError('Credential');

    return { variant, credentialRow };
  });

  const { variant, credentialRow } = resolved;

  // Variant override where present, master copy otherwise — the same
  // precedence the composer previews and validation checks.
  const body = variant.body.length > 0 ? variant.body : variant.post.body;
  const attachments = variant.media.length > 0 ? variant.media : variant.post.media;

  const usable = attachments.filter((item) => item.mediaAsset.status === 'READY');
  if (usable.length !== attachments.length) {
    // An unverified asset must never reach a platform (T1.8).
    throw new ConflictError('Some attached media is not verified', {
      userMessage: 'An attached file has not finished its safety checks.',
    });
  }

  // Decrypted here, in memory, and never logged or serialised (SRS §6). The
  // AAD binds the ciphertext to this organization *and* this account, so a
  // credential row moved between tenants fails to open.
  //
  // Renewed before use when it is close to expiry (D-111): an X token lasts two
  // hours, and the post was usually written longer ago than that.
  const credential: DecryptedCredential = await freshenCredential(
    ctx,
    variant.socialAccountId,
    openCredential(credentialRow, {
      organizationId: ctx.organizationId,
      socialAccountId: variant.socialAccountId,
    }),
  );

  const capabilities = capabilitiesFor(variant.platform, variant.socialAccount.accountType);

  const media: PublishMedia[] = await Promise.all(
    usable.map(async (item) => {
      let storageKey = item.mediaAsset.storageKey;
      let mimeType = item.mediaAsset.mimeType;
      let sizeBytes = item.mediaAsset.sizeBytes;
      let width = item.mediaAsset.width !== null ? item.mediaAsset.width : undefined;
      let height = item.mediaAsset.height !== null ? item.mediaAsset.height : undefined;

      // Platform-specific image format conversion (e.g. PNG -> JPEG for Instagram)
      if (item.mediaAsset.kind === 'IMAGE') {
        const acceptedTypes = capabilities.media.image?.mimeTypes ?? [];
        if (
          !acceptedTypes.includes(mimeType) &&
          isConvertibleImageFormat(mimeType, acceptedTypes)
        ) {
          const targetMime = acceptedTypes.includes('image/jpeg') ? 'image/jpeg' : acceptedTypes[0];
          try {
            const converted = await ensureConvertedImage({
              storageKey,
              targetMimeType: targetMime,
            });
            storageKey = converted.storageKey;
            mimeType = converted.mimeType;
            sizeBytes = converted.sizeBytes;
            if (converted.width) width = converted.width;
            if (converted.height) height = converted.height;
          } catch (error) {
            // The original goes out and the platform refuses it, which fails
            // the post with the platform's own words. Logged here so the cause
            // is findable: the refusal alone would read as a bad file.
            logError('image conversion failed; publishing the original', error, {
              variantId: variant.id,
              mediaAssetId: item.mediaAsset.id,
              from: item.mediaAsset.mimeType,
              to: targetMime ?? 'unknown',
            });
          }
        }
      }

      return {
        id: item.mediaAsset.id,
        kind: item.mediaAsset.kind,
        mimeType,
        sizeBytes,
        // Short-lived and inline: the provider fetches it directly.
        url: (
          await presignDownload({
            key: storageKey,
            contentType: mimeType,
            inline: true,
            expiresInSeconds: MEDIA_URL_TTL_SECONDS,
          })
        ).url,
        ...(item.altText ? { altText: item.altText } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(item.mediaAsset.durationMs !== null ? { durationMs: item.mediaAsset.durationMs } : {}),
        ...(item.mediaAsset.frameRate !== null ? { frameRate: item.mediaAsset.frameRate } : {}),
        ...(item.mediaAsset.peakFrameRate !== null
          ? { peakFrameRate: item.mediaAsset.peakFrameRate }
          : {}),
      };
    }),
  );

  const draft: VariantDraft = {
    // The thread settings the shared engine reads (D-124) — whether a long
    // text goes out as a thread, numbered or not, and whether its posts were
    // edited by hand — decided by the same function the web validator uses,
    // so what was checked and what is published split the same way.
    ...resolveThreadDraft({
      body,
      hasOwnText: variant.body.length > 0,
      platformOptions:
        variant.platformOptions && typeof variant.platformOptions === 'object'
          ? (variant.platformOptions as Record<string, unknown>)
          : undefined,
      capabilities,
    }),
    linkUrl: variant.linkUrl,
    hashtags: variant.hashtags,
    firstComment: variant.firstComment,
    // Settings that exist on one platform only — TikTok's privacy level and
    // post mode are the first. Opaque here on purpose: only the adapter that
    // wrote the keys reads them, and `validateDraft` never looks at all.
    ...(variant.platformOptions && typeof variant.platformOptions === 'object'
      ? { providerOptions: variant.platformOptions as Record<string, unknown> }
      : {}),
    media: media.map((item) => ({
      id: item.id,
      kind: item.kind,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      ...(item.width !== undefined ? { width: item.width } : {}),
      ...(item.height !== undefined ? { height: item.height } : {}),
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
      ...(item.frameRate !== undefined ? { frameRate: item.frameRate } : {}),
      ...(item.peakFrameRate !== undefined ? { peakFrameRate: item.peakFrameRate } : {}),
      ...(item.altText !== undefined ? { altText: item.altText } : {}),
    })),
  };

  return {
    variantId: variant.id,
    postId: variant.postId,
    workspaceId: variant.post.workspaceId,
    brandId: variant.post.brandId,
    socialAccountId: variant.socialAccountId,
    platform: variant.platform,
    accountType: variant.socialAccount.accountType,
    externalId: variant.socialAccount.externalId,
    credential,
    draft,
    media,
    // What an earlier attempt recorded, so a retry can resume rather than
    // restart a transcode that has already been running for a minute.
    ...(variant.providerRef && typeof variant.providerRef === 'object'
      ? { previousRef: variant.providerRef as Record<string, unknown> }
      : {}),
    // The hash the scheduler stamped is authoritative — it is what
    // reconciliation matches on, so recomputing it here would break the match
    // if anything about the content had shifted. Falling back keeps a
    // hand-inserted row publishable.
    contentHash:
      variant.contentHash ??
      computeContentHash({
        body,
        linkUrl: variant.linkUrl,
        mediaKeys: media.map((item) => item.id),
      }),
  };
}
