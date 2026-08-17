import type { Platform, TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import { capabilitiesFor, validateDraft, type ValidationResult } from '@orbit/providers';
import { ensureProvidersRegistered } from '@/server/providers';

/**
 * Server-side validation of a post's variants (SRS §9, §31).
 *
 * Runs the **same** `validateDraft` the composer runs, against the same
 * `PlatformCapabilities`. There is no second implementation to drift, and no
 * platform name in this file — a variant's platform is whatever its account
 * says, and the descriptor does the rest.
 *
 * Media comes from verified `MediaAsset` rows (T1.8), so the dimensions and
 * duration fed to the capability checks are the ones read from the bytes, not
 * anything a client supplied.
 */

export interface VariantValidation {
  variantId: string;
  socialAccountId: string;
  accountName: string;
  platform: Platform;
  result: ValidationResult;
}

export interface PostValidation {
  valid: boolean;
  variants: VariantValidation[];
  /** Problems that are not specific to one account. */
  postIssues: Array<{
    severity: 'ERROR' | 'WARNING';
    code: string;
    field: string;
    message: string;
  }>;
}

/**
 * Resolve a post's variants and validate each against its platform.
 *
 * Effective content is the variant's override where present, falling back to
 * the master post — the same precedence the composer previews, so what a user
 * sees is what is checked.
 */
export async function validatePost(ctx: TenantContext, postId: string): Promise<PostValidation> {
  ensureProvidersRegistered();

  const post = await withTenant(ctx, (db) =>
    db.post.findFirst({
      where: { id: postId, deletedAt: null },
      select: {
        id: true,
        body: true,
        scheduledFor: true,
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
                status: true,
              },
            },
          },
        },
        variants: {
          where: { deletedAt: null },
          select: {
            id: true,
            platform: true,
            body: true,
            linkUrl: true,
            hashtags: true,
            firstComment: true,
            platformOptions: true,
            scheduledFor: true,
            socialAccountId: true,
            socialAccount: {
              select: { displayName: true, accountType: true, status: true },
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
                    status: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
  );

  const postIssues: PostValidation['postIssues'] = [];

  if (!post) {
    return { valid: false, variants: [], postIssues };
  }

  if (post.variants.length === 0) {
    postIssues.push({
      severity: 'ERROR',
      code: 'NO_ACCOUNTS_SELECTED',
      field: 'socialAccountIds',
      message: 'Choose at least one account to publish to.',
    });
  }

  // An unverified asset must never reach a platform.
  const masterMedia = post.media.filter((m) => m.mediaAsset.status === 'READY');
  if (masterMedia.length !== post.media.length) {
    postIssues.push({
      severity: 'ERROR',
      code: 'MEDIA_NOT_READY',
      field: 'media',
      message: 'Some attached files are still being checked, or failed their checks.',
    });
  }

  const variants: VariantValidation[] = post.variants.map((variant) => {
    const capabilities = capabilitiesFor(variant.platform, variant.socialAccount.accountType);

    const attachments = variant.media.length > 0 ? variant.media : post.media;
    const usable = attachments.filter((m) => m.mediaAsset.status === 'READY');

    const result = validateDraft(capabilities, {
      // Variant overrides win; an unset override inherits the master copy.
      body: variant.body.length > 0 ? variant.body : post.body,
      linkUrl: variant.linkUrl,
      hashtags: variant.hashtags,
      firstComment: variant.firstComment,
      scheduledFor: variant.scheduledFor ?? post.scheduledFor ?? undefined,
      // Threaded through so the composer checks the same draft the worker will
      // publish. `validateDraft` ignores it; an adapter reads its own keys.
      ...(variant.platformOptions && typeof variant.platformOptions === 'object'
        ? { providerOptions: variant.platformOptions as Record<string, unknown> }
        : {}),
      media: usable.map((m) => ({
        id: m.mediaAsset.id,
        kind: m.mediaAsset.kind,
        mimeType: m.mediaAsset.mimeType,
        sizeBytes: m.mediaAsset.sizeBytes,
        width: m.mediaAsset.width ?? undefined,
        height: m.mediaAsset.height ?? undefined,
        durationMs: m.mediaAsset.durationMs ?? undefined,
        altText: m.altText ?? undefined,
      })),
    });

    // An account that cannot publish is a blocker for this variant, and the
    // capability layer has no way to know it — it describes the platform, not
    // the connection.
    if (variant.socialAccount.status !== 'ACTIVE') {
      result.issues.push({
        severity: 'ERROR',
        code: 'ACCOUNT_NEEDS_RECONNECT',
        field: 'socialAccountId',
        message: `${variant.socialAccount.displayName} needs to be reconnected before it can publish.`,
      });
      result.valid = false;
    }

    return {
      variantId: variant.id,
      socialAccountId: variant.socialAccountId,
      accountName: variant.socialAccount.displayName,
      platform: variant.platform,
      result,
    };
  });

  const valid =
    postIssues.every((i) => i.severity !== 'ERROR') && variants.every((v) => v.result.valid);

  return { valid, variants, postIssues };
}
