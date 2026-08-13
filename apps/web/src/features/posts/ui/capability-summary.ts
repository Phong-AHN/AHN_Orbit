import type { Platform } from '@orbit/core';
import { capabilitiesFor } from '@orbit/providers';

/**
 * The slice of a `PlatformCapabilities` descriptor the composer needs to give
 * instant feedback — a character counter that turns red before the round trip,
 * an attachment limit, whether a first comment field should exist at all.
 *
 * It is deliberately a *summary*, not the descriptor. The composer never
 * decides validity: it debounces to `/validate`, which runs the real engine
 * against the full descriptor server-side. Sending the whole descriptor to the
 * browser would invite a second implementation growing here, which is exactly
 * the drift the shared engine exists to prevent.
 */

export interface CapabilitySummary {
  platform: Platform;
  maxTextLength: number;
  allowsEmptyWithMedia: boolean;
  maxAttachments: number;
  supportsLink: boolean;
  supportsHashtags: boolean;
  maxHashtags: number | null;
  supportsMentions: boolean;
  supportsFirstComment: boolean;
  maxFirstCommentLength: number | null;
  supportsAltText: boolean;
  mediaRequired: boolean;
  carousel: boolean;
}

export function summariseCapabilities(
  platform: Platform,
  accountType: string | null,
): CapabilitySummary {
  const c = capabilitiesFor(platform, accountType);

  return {
    platform: c.platform,
    maxTextLength: c.text.maxLength,
    allowsEmptyWithMedia: c.text.allowsEmptyWithMedia,
    maxAttachments: c.media.maxAttachments,
    supportsLink: c.link.supported,
    supportsHashtags: c.hashtags.supported,
    maxHashtags: c.hashtags.maxCount ?? null,
    supportsMentions: c.mentions.supported,
    supportsFirstComment: c.firstComment.supported,
    maxFirstCommentLength: c.firstComment.maxLength ?? null,
    supportsAltText: c.media.altText,
    mediaRequired: c.media.required,
    carousel: c.media.carousel,
  };
}
