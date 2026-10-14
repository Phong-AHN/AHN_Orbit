import type { Platform } from '@orbit/core';
import { capabilitiesFor, type MediaConstraint } from '@orbit/providers';
import type { MediaCapabilityView, MediaConstraintView } from '@/features/media/ui/facts';

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
 *
 * ## The media block is the one exception, and it is for prose only
 *
 * `media` carries the actual numeric constraints, which is uncomfortably close
 * to what that warning is about. It is here because the alternative was worse:
 * the composer could say a video had been refused and could not say what the
 * platform wanted, so somebody re-exported the same clip three times guessing
 * at the limit. The numbers are needed to *write the sentence* — "MP4, up to
 * 10:00, 23–60 fps".
 *
 * **Nothing reads these numbers to compare them against a file.** The functions
 * that consume this block (`describeMediaNeed`, `describeConstraint`) only turn
 * them into text; there is deliberately no browser-side function that takes a
 * constraint and a file and returns a verdict. Every pass or fail on screen
 * comes from the `/validate` response. If a comparison ever appears here, the
 * drift this file warns about has started.
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
  /** For describing requirements in prose. Never for deciding them. */
  media: MediaCapabilityView;
}

/**
 * Narrow a descriptor constraint to the fields the requirement text uses.
 *
 * Field by field rather than spreading the constraint: a new descriptor field
 * should have to be deliberately added here before it reaches the browser,
 * which is the same reason the summary exists at all.
 */
function constraintView(constraint: MediaConstraint | null): MediaConstraintView | null {
  if (!constraint || constraint.mimeTypes.length === 0) return null;

  return {
    mimeTypes: constraint.mimeTypes,
    maxBytes: constraint.maxBytes,
    minWidth: constraint.minWidth,
    minHeight: constraint.minHeight,
    maxWidth: constraint.maxWidth,
    maxHeight: constraint.maxHeight,
    minAspectRatio: constraint.minAspectRatio,
    maxAspectRatio: constraint.maxAspectRatio,
    minDurationMs: constraint.minDurationMs,
    maxDurationMs: constraint.maxDurationMs,
    minFrameRate: constraint.minFrameRate,
    maxFrameRate: constraint.maxFrameRate,
  };
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
    media: {
      image: constraintView(c.media.image),
      video: constraintView(c.media.video),
      gif: constraintView(c.media.gif),
      maxAttachments: c.media.maxAttachments,
      allowsMixedKinds: c.media.allowsMixedKinds,
      required: c.media.required,
      altText: c.media.altText,
    },
  };
}
