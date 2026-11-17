import type { Platform, TenantContext } from '@orbit/core';
import { withTenant } from '@orbit/db';
import {
  capabilitiesFor,
  missingThreadScopes,
  threadNumbered,
  threadPartsFor,
  threadRequested,
  validateDraft,
  type ValidationResult,
  type VariantDraft,
} from '@orbit/providers';
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
  /**
   * The posts this variant will publish as, when it is a thread of two or
   * more (D-124). From the same split the adapter publishes, so the composer
   * shows exactly what will go out rather than its own guess.
   */
  threadParts?: string[] | undefined;
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
                frameRate: true,
                peakFrameRate: true,
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
              select: { displayName: true, accountType: true, status: true, scopes: true },
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

    const options =
      variant.platformOptions && typeof variant.platformOptions === 'object'
        ? (variant.platformOptions as Record<string, unknown>)
        : undefined;
    // The one setting in `platformOptions` the shared engine reads (D-124):
    // it changes how many posts the text becomes, which every layer must agree
    // on. On unless switched off, wherever the platform can thread.
    const thread = threadRequested(options, capabilities);

    const draft: VariantDraft = {
      // Variant overrides win; an unset override inherits the master copy.
      body: variant.body.length > 0 ? variant.body : post.body,
      linkUrl: variant.linkUrl,
      hashtags: variant.hashtags,
      firstComment: variant.firstComment,
      scheduledFor: variant.scheduledFor ?? post.scheduledFor ?? undefined,
      ...(thread ? { thread: true } : {}),
      ...(thread && !threadNumbered(options) ? { threadNumbering: false } : {}),
      // Threaded through so the composer checks the same draft the worker will
      // publish. `validateDraft` ignores it; an adapter reads its own keys.
      ...(options ? { providerOptions: options } : {}),
      media: usable.map((m) => ({
        id: m.mediaAsset.id,
        kind: m.mediaAsset.kind,
        mimeType: m.mediaAsset.mimeType,
        sizeBytes: m.mediaAsset.sizeBytes,
        width: m.mediaAsset.width ?? undefined,
        height: m.mediaAsset.height ?? undefined,
        durationMs: m.mediaAsset.durationMs ?? undefined,
        frameRate: m.mediaAsset.frameRate ?? undefined,
        peakFrameRate: m.mediaAsset.peakFrameRate ?? undefined,
        altText: m.altText ?? undefined,
      })),
    };

    const result = validateDraft(capabilities, draft);

    const parts = thread ? threadPartsFor(draft, capabilities) : [];

    /**
     * A thread on a connection that cannot reply (D-124). The capability layer
     * describes the platform, not the connection, so this is checked here —
     * and the adapter refuses again before posting anything, because a thread
     * that stops after its first post is worse than one that never starts.
     * Only when the text is really split: threads are on by default, and a
     * post that fits needs no reply permission.
     */
    const missingForThread =
      parts.length > 1 ? missingThreadScopes(capabilities, variant.socialAccount.scopes) : [];
    if (missingForThread.length > 0) {
      result.issues.push({
        severity: 'ERROR',
        code: 'THREAD_NEEDS_RECONNECT',
        field: 'thread',
        message: `${variant.socialAccount.displayName} was connected before threads were switched on. Reconnect it to publish this as a thread, or shorten the text.`,
        meta: { missing: missingForThread.join(', ') },
      });
      result.valid = false;
    }

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

    // The adapter refuses a pin with no board, but only at publish time — long
    // after the post was approved and scheduled. Refused here, the post cannot
    // leave DRAFT without one.
    if (variant.platform === 'PINTEREST') {
      const options = (variant.platformOptions ?? {}) as Record<string, unknown>;
      if (typeof options['boardId'] !== 'string' || options['boardId'].trim().length === 0) {
        result.issues.push({
          severity: 'ERROR',
          code: 'PINTEREST_BOARD_REQUIRED',
          field: 'platformOptions.boardId',
          message: `Choose which Pinterest board ${variant.socialAccount.displayName}'s pin belongs on, and save the Pinterest settings.`,
        });
        result.valid = false;
      }
    }

    return {
      variantId: variant.id,
      socialAccountId: variant.socialAccountId,
      accountName: variant.socialAccount.displayName,
      platform: variant.platform,
      result,
      ...(parts.length > 1 ? { threadParts: parts } : {}),
    };
  });

  const valid =
    postIssues.every((i) => i.severity !== 'ERROR') && variants.every((v) => v.result.valid);

  return { valid, variants, postIssues };
}
