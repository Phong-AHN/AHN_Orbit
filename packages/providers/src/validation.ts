import type { MediaKind } from '@orbit/core';
import type { MediaConstraint, PlatformCapabilities } from './capabilities.js';

/**
 * Capability-driven validation (SRS §9).
 *
 * Pure and synchronous by design, so the *same function* runs in the composer
 * for instant feedback and again on the server before enqueue. Two
 * implementations would eventually disagree, and the one that disagreed
 * silently would be the server's.
 *
 * Every rule is read from the descriptor. There is no platform name anywhere in
 * this file, and there must never be one.
 */

export type ValidationSeverity = 'ERROR' | 'WARNING';

export interface ValidationIssue {
  severity: ValidationSeverity;
  /** Stable machine code, for tests and for mapping to UI affordances. */
  code: string;
  /** Which part of the draft is at fault: 'body', 'media[2]', 'linkUrl'. */
  field: string;
  /** Safe to display verbatim. */
  message: string;
  meta?: Record<string, number | string | boolean> | undefined;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

/** Media already uploaded and verified, as the composer knows it. */
export interface DraftMedia {
  id: string;
  kind: MediaKind;
  mimeType: string;
  sizeBytes: number;
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
  altText?: string | undefined;
}

/** One post as it would be published to one account. */
export interface VariantDraft {
  body: string;
  linkUrl?: string | null | undefined;
  hashtags?: readonly string[] | undefined;
  mentions?: readonly string[] | undefined;
  firstComment?: string | null | undefined;
  media?: readonly DraftMedia[] | undefined;
  /** When the post is due, for provider-side scheduling windows. */
  scheduledFor?: Date | undefined;
  /** Evaluated against `lifecycle.editOwnPostsOnly` when editing. */
  createdByThisApp?: boolean | undefined;
  /**
   * Settings that exist on exactly one platform, kept opaque on purpose.
   *
   * TikTok's `privacy_level`, `disable_duet` and post mode are the motivating
   * case: they are mandatory there and meaningless everywhere else. Promoting
   * them to real fields on this interface would put TikTok's vocabulary into
   * the contract every platform shares, which is the drift this whole layer
   * exists to prevent.
   *
   * **Nothing in this file reads it.** `validateDraft` stays platform-agnostic;
   * only the adapter that wrote the keys interprets them, and an adapter that
   * finds keys it does not recognise ignores them.
   */
  providerOptions?: Record<string, unknown> | undefined;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

function issue(
  severity: ValidationSeverity,
  code: string,
  field: string,
  message: string,
  meta?: ValidationIssue['meta'],
): ValidationIssue {
  return { severity, code, field, message, meta };
}

/**
 * Effective character count.
 *
 * Uses code points rather than UTF-16 units, because an emoji is one character
 * to a user and two to `String.length` — counting units would reject posts the
 * platform accepts. Platforms that bill links at a fixed cost are handled by
 * `linkCharacterCost`.
 */
export function countCharacters(body: string, capabilities: PlatformCapabilities): number {
  const cost = capabilities.text.linkCharacterCost;
  if (cost === undefined) return [...body].length;

  const links = body.match(URL_PATTERN) ?? [];
  const withoutLinks = body.replace(URL_PATTERN, '');
  return [...withoutLinks].length + links.length * cost;
}

function validateMediaItem(
  item: DraftMedia,
  constraint: MediaConstraint | null,
  field: string,
  kindLabel: string,
): ValidationIssue[] {
  if (!constraint) {
    return [issue('ERROR', 'MEDIA_KIND_UNSUPPORTED', field, `${kindLabel} isn't supported here.`)];
  }

  const issues: ValidationIssue[] = [];

  if (!constraint.mimeTypes.includes(item.mimeType)) {
    // Naming what *is* accepted turns a dead end into an instruction. The list
    // was already in the metadata and nothing rendered it, so the reader was
    // told their file was wrong and left to guess what would be right.
    issues.push(
      issue(
        'ERROR',
        'MEDIA_TYPE_UNSUPPORTED',
        field,
        `${item.mimeType} isn't accepted here — this platform takes ${constraint.mimeTypes.join(', ')}.`,
        { accepted: constraint.mimeTypes.join(', ') },
      ),
    );
  }

  if (item.sizeBytes > constraint.maxBytes) {
    issues.push(
      issue('ERROR', 'MEDIA_TOO_LARGE', field, `This file is larger than the limit.`, {
        sizeBytes: item.sizeBytes,
        maxBytes: constraint.maxBytes,
      }),
    );
  }

  if (item.width !== undefined && item.height !== undefined) {
    if (constraint.minWidth !== undefined && item.width < constraint.minWidth) {
      issues.push(
        issue('ERROR', 'MEDIA_TOO_NARROW', field, 'This image is narrower than the minimum.', {
          width: item.width,
          minWidth: constraint.minWidth,
        }),
      );
    }
    if (constraint.minHeight !== undefined && item.height < constraint.minHeight) {
      issues.push(
        issue('ERROR', 'MEDIA_TOO_SHORT', field, 'This image is shorter than the minimum.', {
          height: item.height,
          minHeight: constraint.minHeight,
        }),
      );
    }
    if (constraint.maxWidth !== undefined && item.width > constraint.maxWidth) {
      issues.push(
        issue('ERROR', 'MEDIA_TOO_WIDE', field, 'This image is wider than the maximum.', {
          width: item.width,
          maxWidth: constraint.maxWidth,
        }),
      );
    }
    if (constraint.maxHeight !== undefined && item.height > constraint.maxHeight) {
      issues.push(
        issue('ERROR', 'MEDIA_TOO_TALL', field, 'This image is taller than the maximum.', {
          height: item.height,
          maxHeight: constraint.maxHeight,
        }),
      );
    }

    const ratio = item.width / item.height;
    // Rounded to 4 places so a 1080×1920 upload is not rejected by float noise.
    const rounded = Math.round(ratio * 10_000) / 10_000;
    if (constraint.minAspectRatio !== undefined && rounded < constraint.minAspectRatio) {
      issues.push(
        issue('ERROR', 'MEDIA_ASPECT_TOO_TALL', field, 'This is too tall for the platform.', {
          aspectRatio: rounded,
          minAspectRatio: constraint.minAspectRatio,
        }),
      );
    }
    if (constraint.maxAspectRatio !== undefined && rounded > constraint.maxAspectRatio) {
      issues.push(
        issue('ERROR', 'MEDIA_ASPECT_TOO_WIDE', field, 'This is too wide for the platform.', {
          aspectRatio: rounded,
          maxAspectRatio: constraint.maxAspectRatio,
        }),
      );
    }
  }

  if (item.durationMs !== undefined) {
    if (constraint.minDurationMs !== undefined && item.durationMs < constraint.minDurationMs) {
      issues.push(
        issue('ERROR', 'MEDIA_TOO_SHORT_DURATION', field, 'This video is shorter than allowed.', {
          durationMs: item.durationMs,
          minDurationMs: constraint.minDurationMs,
        }),
      );
    }
    if (constraint.maxDurationMs !== undefined && item.durationMs > constraint.maxDurationMs) {
      issues.push(
        issue('ERROR', 'MEDIA_TOO_LONG_DURATION', field, 'This video is longer than allowed.', {
          durationMs: item.durationMs,
          maxDurationMs: constraint.maxDurationMs,
        }),
      );
    }
  }

  return issues;
}

/**
 * Validate one draft against one platform's capabilities.
 *
 * Returns every problem rather than the first, so the composer can show a
 * complete list instead of making the user fix issues one at a time.
 */
export function validateDraft(
  capabilities: PlatformCapabilities,
  draft: VariantDraft,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const media = draft.media ?? [];

  // ── Text ────────────────────────────────────────────────────────────────
  const trimmed = draft.body.trim();

  if (!capabilities.text.supported && trimmed.length > 0) {
    issues.push(issue('ERROR', 'TEXT_UNSUPPORTED', 'body', 'This platform does not accept text.'));
  }

  if (capabilities.text.supported) {
    const count = countCharacters(draft.body, capabilities);
    if (count > capabilities.text.maxLength) {
      issues.push(
        issue('ERROR', 'TEXT_TOO_LONG', 'body', 'This is longer than the platform allows.', {
          count,
          maxLength: capabilities.text.maxLength,
        }),
      );
    } else if (count > capabilities.text.maxLength * 0.9) {
      issues.push(
        issue('WARNING', 'TEXT_NEAR_LIMIT', 'body', 'You are close to the character limit.', {
          count,
          maxLength: capabilities.text.maxLength,
        }),
      );
    }
  }

  if (trimmed.length === 0 && media.length === 0) {
    issues.push(issue('ERROR', 'POST_EMPTY', 'body', 'A post needs text or media.'));
  }

  if (trimmed.length === 0 && media.length > 0 && !capabilities.text.allowsEmptyWithMedia) {
    issues.push(
      issue('ERROR', 'TEXT_REQUIRED_WITH_MEDIA', 'body', 'This platform requires a caption.'),
    );
  }

  // ── Links ───────────────────────────────────────────────────────────────
  const bodyLinks = draft.body.match(URL_PATTERN) ?? [];
  const totalLinks = bodyLinks.length + (draft.linkUrl ? 1 : 0);

  if (totalLinks > 0 && !capabilities.link.supported) {
    issues.push(
      issue('ERROR', 'LINK_UNSUPPORTED', 'linkUrl', 'Links are not supported on this platform.'),
    );
  } else if (capabilities.link.supported && totalLinks > capabilities.link.maxCount) {
    issues.push(
      issue('ERROR', 'TOO_MANY_LINKS', 'linkUrl', 'This platform allows fewer links.', {
        count: totalLinks,
        maxCount: capabilities.link.maxCount,
      }),
    );
  }

  // ── Media ───────────────────────────────────────────────────────────────
  if (capabilities.media.required && media.length === 0) {
    issues.push(
      issue('ERROR', 'MEDIA_REQUIRED', 'media', 'This platform requires an image or video.'),
    );
  }

  if (media.length > capabilities.media.maxAttachments) {
    issues.push(
      issue('ERROR', 'TOO_MANY_ATTACHMENTS', 'media', 'Too many attachments for this platform.', {
        count: media.length,
        maxAttachments: capabilities.media.maxAttachments,
      }),
    );
  }

  const kinds = new Set(media.map((m) => m.kind));
  if (kinds.size > 1 && !capabilities.media.allowsMixedKinds) {
    issues.push(
      issue(
        'ERROR',
        'MIXED_MEDIA_UNSUPPORTED',
        'media',
        'Images and video cannot be combined here.',
      ),
    );
  }

  media.forEach((item, index) => {
    const field = `media[${index}]`;
    const constraint =
      item.kind === 'IMAGE'
        ? capabilities.media.image
        : item.kind === 'VIDEO'
          ? capabilities.media.video
          : capabilities.media.gif;

    const label = item.kind === 'IMAGE' ? 'Images' : item.kind === 'VIDEO' ? 'Video' : 'GIFs';
    issues.push(...validateMediaItem(item, constraint, field, label));

    if (item.altText && !capabilities.media.altText) {
      issues.push(
        issue('WARNING', 'ALT_TEXT_DROPPED', field, 'Alt text will not be sent to this platform.'),
      );
    }
  });

  // ── Hashtags and mentions ───────────────────────────────────────────────
  const hashtags = draft.hashtags ?? [];
  if (hashtags.length > 0 && !capabilities.hashtags.supported) {
    issues.push(
      issue('WARNING', 'HASHTAGS_UNSUPPORTED', 'hashtags', 'Hashtags carry no meaning here.'),
    );
  } else if (
    capabilities.hashtags.maxCount !== undefined &&
    hashtags.length > capabilities.hashtags.maxCount
  ) {
    issues.push(
      issue('ERROR', 'TOO_MANY_HASHTAGS', 'hashtags', 'Too many hashtags for this platform.', {
        count: hashtags.length,
        maxCount: capabilities.hashtags.maxCount,
      }),
    );
  }

  if ((draft.mentions?.length ?? 0) > 0 && !capabilities.mentions.supported) {
    issues.push(
      issue(
        'WARNING',
        'MENTIONS_UNSUPPORTED',
        'mentions',
        'Mentions will be posted as plain text.',
      ),
    );
  }

  // ── First comment ───────────────────────────────────────────────────────
  const firstComment = draft.firstComment?.trim() ?? '';
  if (firstComment.length > 0) {
    if (!capabilities.firstComment.supported) {
      issues.push(
        issue(
          'ERROR',
          'FIRST_COMMENT_UNSUPPORTED',
          'firstComment',
          'First comments are not supported here.',
        ),
      );
    } else if (
      capabilities.firstComment.maxLength !== undefined &&
      [...firstComment].length > capabilities.firstComment.maxLength
    ) {
      issues.push(
        issue('ERROR', 'FIRST_COMMENT_TOO_LONG', 'firstComment', 'The first comment is too long.', {
          count: [...firstComment].length,
          maxLength: capabilities.firstComment.maxLength,
        }),
      );
    }
  }

  // ── Provider-side scheduling window ─────────────────────────────────────
  // Only meaningful when the provider holds the post. Orbit's own scheduler is
  // unaffected by these bounds, so this is a warning, not a failure.
  if (draft.scheduledFor && capabilities.scheduling.providerSide) {
    const lead = draft.scheduledFor.getTime() - Date.now();
    const { minLeadMs, maxLeadMs } = capabilities.scheduling;

    if (minLeadMs !== undefined && lead < minLeadMs) {
      issues.push(
        issue(
          'WARNING',
          'SCHEDULE_TOO_SOON',
          'scheduledFor',
          'Too soon for the platform to hold this post; it will be published by Orbit instead.',
          {
            leadMs: lead,
            minLeadMs,
          },
        ),
      );
    }
    if (maxLeadMs !== undefined && lead > maxLeadMs) {
      issues.push(
        issue(
          'WARNING',
          'SCHEDULE_TOO_FAR',
          'scheduledFor',
          'Further ahead than the platform will hold; Orbit will publish it at the right time.',
          {
            leadMs: lead,
            maxLeadMs,
          },
        ),
      );
    }
  }

  return { valid: !issues.some((i) => i.severity === 'ERROR'), issues };
}

/** Whether an existing post may be edited, given who created it. */
export function canEditPublished(
  capabilities: PlatformCapabilities,
  createdByThisApp: boolean,
): { allowed: boolean; reason?: string } {
  if (!capabilities.lifecycle.edit) {
    return { allowed: false, reason: 'This platform does not allow editing a published post.' };
  }
  if (capabilities.lifecycle.editOwnPostsOnly && !createdByThisApp) {
    return {
      allowed: false,
      reason: 'This post was created outside Orbit, so the platform will not let us edit it.',
    };
  }
  return { allowed: true };
}

export const errorsOnly = (result: ValidationResult): ValidationIssue[] =>
  result.issues.filter((i) => i.severity === 'ERROR');
