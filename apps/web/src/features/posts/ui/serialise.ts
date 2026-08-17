import type { getPost } from '../service';
import type { PostDetail } from './api';

/**
 * Convert a post row into the shape the composer receives.
 *
 * Explicit rather than a `JSON.parse(JSON.stringify(...))` round trip: a server
 * component can only hand a client component serialisable values, and writing
 * the mapping out means a new `Date` or `Decimal` column is a type error here
 * rather than a runtime crash in the browser.
 *
 * **That guarantee only holds while the target fields are required.** It did
 * not hold for `platformOptions`: declaring it optional on `PostVariantSummary`
 * meant omitting it here type-checked perfectly, so a TikTok post's visibility
 * survived a save, appeared in the panel, and vanished on the next page load —
 * the value was in the database the whole time and simply never made the trip
 * back. Every field on that summary is now required for exactly this reason;
 * `| null` carries "not set" instead.
 */
export function serialisePost(post: Awaited<ReturnType<typeof getPost>>): PostDetail {
  return {
    id: post.id,
    title: post.title,
    body: post.body,
    status: post.status,
    workspaceId: post.workspaceId,
    brandId: post.brandId,
    createdById: post.createdById,
    assignedToId: post.assignedToId,
    approvalRequired: post.approvalRequired,
    scheduledFor: post.scheduledFor?.toISOString() ?? null,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
    variants: post.variants.map((variant) => ({
      id: variant.id,
      socialAccountId: variant.socialAccountId,
      platform: variant.platform,
      body: variant.body,
      linkUrl: variant.linkUrl,
      hashtags: variant.hashtags,
      firstComment: variant.firstComment,
      // Opaque here on purpose — only the platform's own panel reads its keys.
      platformOptions: (variant.platformOptions ?? null) as Record<string, unknown> | null,
      status: variant.status,
      externalPermalink: variant.externalPermalink,
      socialAccount: {
        id: variant.socialAccount.id,
        displayName: variant.socialAccount.displayName,
        handle: variant.socialAccount.handle,
        status: variant.socialAccount.status,
      },
    })),
    media: post.media.map((item) => ({
      position: item.position,
      altText: item.altText,
      mediaAsset: {
        id: item.mediaAsset.id,
        kind: item.mediaAsset.kind,
        mimeType: item.mediaAsset.mimeType,
        width: item.mediaAsset.width,
        height: item.mediaAsset.height,
      },
    })),
  };
}
