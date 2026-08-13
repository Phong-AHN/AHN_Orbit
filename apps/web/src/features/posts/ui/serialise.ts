import type { getPost } from '../service';
import type { PostDetail } from './api';

/**
 * Convert a post row into the shape the composer receives.
 *
 * Explicit rather than a `JSON.parse(JSON.stringify(...))` round trip: a server
 * component can only hand a client component serialisable values, and writing
 * the mapping out means a new `Date` or `Decimal` column is a type error here
 * rather than a runtime crash in the browser.
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
