import type { MediaKind } from '@orbit/core';
import type { MediaConstraint, PlatformCapabilities } from './capabilities.js';
import { assignThreadMedia, splitIntoThread, splitManualThread, threadMarker } from './thread.js';

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
  /** Average frames per second, read from the file's own sample table. */
  frameRate?: number | undefined;
  /** Highest instantaneous rate. This is the figure platforms object to. */
  peakFrameRate?: number | undefined;
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
   * Publish text longer than one post as a thread rather than refuse it
   * (**D-124**). Honoured only where `capabilities.thread.supported`; anywhere
   * else it is an error, not something quietly ignored. Text that fits in one
   * post is published as one post either way.
   */
  thread?: boolean | undefined;
  /**
   * End each post of a thread with its place (" 2/5"). On unless `false`.
   * Changes where the text breaks, so the validator, the composer and the
   * adapter all read it from the draft.
   */
  threadNumbering?: boolean | undefined;
  /**
   * The body holds the thread's posts as somebody edited them, separated by
   * `---` lines (`joinManualThread`). Each is published as written — plus its
   * place, if numbered — instead of being split automatically.
   */
  threadManual?: boolean | undefined;
  /**
   * Which post of a thread an attachment goes with, by media id (0 is the
   * first post). Attachments not listed are placed by `assignThreadMedia`.
   */
  threadMedia?: Readonly<Record<string, number>> | undefined;
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
  const length = capabilities.text.weightedCounting
    ? weightedLength
    : capabilities.text.countGraphemes
      ? graphemeLength
      : (text: string) => [...text].length;

  const cost = capabilities.text.linkCharacterCost;
  if (cost === undefined) return length(body);

  const links = body.match(URL_PATTERN) ?? [];
  const withoutLinks = body.replace(URL_PATTERN, '');
  return length(withoutLinks) + links.length * cost;
}

/**
 * The text of a post on a platform with no separate hashtag or link field.
 *
 * Body, then the hashtags, then the destination link, a blank line apart —
 * and neither repeated when the body already carries it, so a writer who
 * typed the link into the text does not get it twice. The validator counts
 * this and the adapter publishes it; being one function is what keeps the
 * composer's count and the platform's verdict the same.
 */
export function composePublishedText(
  draft: Pick<VariantDraft, 'body' | 'hashtags' | 'linkUrl'>,
): string {
  const body = draft.body.trim();
  const tags = (draft.hashtags ?? [])
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
    .filter((tag) => !body.includes(tag))
    .join(' ');
  const link = draft.linkUrl && !body.includes(draft.linkUrl) ? draft.linkUrl : '';

  return [body, tags, link].filter((part) => part.length > 0).join('\n\n');
}

/**
 * The text a platform receives for this draft, which is what its limit is
 * counted against: body, hashtags and link where all three are written in;
 * body and hashtags where the link travels separately; the body alone where
 * neither is.
 */
export function publishedTextFor(
  draft: Pick<VariantDraft, 'body' | 'hashtags' | 'linkUrl'>,
  capabilities: PlatformCapabilities,
): string {
  if (capabilities.text.composedText) return composePublishedText(draft);
  if (capabilities.text.hashtagsInText) {
    return composePublishedText({ body: draft.body, hashtags: draft.hashtags });
  }
  return draft.body;
}

/**
 * The posts a draft becomes, in order: one element unless it is a thread.
 *
 * What is split is the text as published — body, then hashtags, then the link
 * where the platform writes it into the text — so the hashtags close the last
 * post of a thread rather than being repeated on every one. A platform that
 * sends the link separately (Threads' link card) attaches it to the first post.
 *
 * The validator counts these, the composer shows them and the adapter
 * publishes them: the same function in all three places.
 */
export function threadPartsFor(
  draft: Pick<
    VariantDraft,
    'body' | 'hashtags' | 'linkUrl' | 'thread' | 'threadNumbering' | 'threadManual'
  >,
  capabilities: PlatformCapabilities,
): string[] {
  if (draft.thread !== true || !capabilities.thread.supported) {
    return [publishedTextFor(draft, capabilities)];
  }

  if (draft.threadManual === true) return manualThreadParts(draft, capabilities);

  const source = composePublishedText({
    body: draft.body,
    hashtags: draft.hashtags,
    linkUrl: capabilities.text.composedText ? draft.linkUrl : null,
  });

  return splitIntoThread(
    source,
    capabilities.text.maxLength,
    (text) => countCharacters(text, capabilities),
    { numbered: draft.threadNumbering !== false },
  );
}

/**
 * A thread edited by hand: each post as written.
 *
 * The hashtags and the link (where the platform writes it into the text)
 * close the last post, as in a split one — but only those not already in a
 * post, because editing usually starts from a split that put them there.
 * Numbered as a split thread is, and checked against the limit post by post
 * like one: a post somebody made too long is refused, not split further.
 */
function manualThreadParts(
  draft: Pick<VariantDraft, 'body' | 'hashtags' | 'linkUrl' | 'threadNumbering'>,
  capabilities: PlatformCapabilities,
): string[] {
  const sections = splitManualThread(draft.body);
  if (sections.length === 0) return [''];

  const written = sections.join('\n');
  const missingTags = (draft.hashtags ?? [])
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`))
    .filter((tag) => !written.includes(tag));
  const link =
    capabilities.text.composedText && draft.linkUrl && !written.includes(draft.linkUrl)
      ? draft.linkUrl
      : null;

  const parts = [
    ...sections.slice(0, -1),
    composePublishedText({
      body: sections[sections.length - 1] as string,
      hashtags: missingTags,
      linkUrl: link,
    }),
  ];

  if (parts.length === 1 || draft.threadNumbering === false) return parts;
  return parts.map((part, index) => `${part}${threadMarker(index + 1, parts.length)}`);
}

/**
 * The ranges X counts as one character; everything else counts as two.
 *
 * From X's published counting configuration (twitter-text v3): Latin, Greek,
 * Cyrillic and the like up to U+10FF, plus three blocks of general punctuation.
 * Vietnamese is split across the line — "á" and "ư" are in it, "ạ" and "ệ"
 * (Latin Extended Additional, U+1E00–U+1EFF) are not.
 */
const LIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

const codePointWeight = (codePoint: number) =>
  LIGHT_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high) ? 1 : 2;

const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

/** Grapheme clusters, as Bluesky counts them. Code points where no segmenter exists. */
export function graphemeLength(text: string): number {
  return graphemes ? Array.from(graphemes.segment(text)).length : [...text].length;
}

/**
 * Length as X counts it.
 *
 * NFC first, as X does, so a letter typed as a base plus a combining mark
 * counts the same as its precomposed form. An emoji sequence — a skin tone, a
 * ZWJ family, a heart with its variation selector — counts as one emoji, 2.
 */
export function weightedLength(text: string): number {
  const normalized = text.normalize('NFC');
  const segments = graphemes
    ? Array.from(graphemes.segment(normalized), (part) => part.segment)
    : [...normalized];

  let total = 0;
  for (const segment of segments) {
    const points = [...segment];
    if (points.length > 1 && /\p{Extended_Pictographic}/u.test(segment)) {
      total += 2;
      continue;
    }
    for (const point of points) total += codePointWeight(point.codePointAt(0) ?? 0);
  }
  return total;
}

/**
 * Whether Orbit's automatic image conversion pipeline can convert the source
 * image MIME type to one of the accepted MIME types for the target platform.
 *
 * For instance, Instagram Graph API requires JPEG. If a user uploads a PNG,
 * Orbit automatically converts it to JPEG with transparency flattening
 * (.flatten({ background: '#ffffff' })) and sRGB profile.
 */
export function isConvertibleImageFormat(
  sourceMimeType: string,
  acceptedMimeTypes: readonly string[],
): boolean {
  if (acceptedMimeTypes.includes(sourceMimeType)) return true;

  // Convert PNG or WebP to JPEG if platform requires JPEG
  if (acceptedMimeTypes.includes('image/jpeg')) {
    if (sourceMimeType === 'image/png' || sourceMimeType === 'image/webp') {
      return true;
    }
  }

  // Convert JPEG or WebP to PNG if platform requires PNG
  if (acceptedMimeTypes.includes('image/png')) {
    if (sourceMimeType === 'image/jpeg' || sourceMimeType === 'image/webp') {
      return true;
    }
  }

  return false;
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
    const autoConvertible =
      item.kind === 'IMAGE' && isConvertibleImageFormat(item.mimeType, constraint.mimeTypes);

    if (!autoConvertible) {
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

  /**
   * Frame rate, checked against the **peak** rather than the average.
   *
   * A phone records variable frame rate by default: the file is labelled 30fps,
   * the average is about 30, and the instantaneous rate spikes far past any
   * ceiling. The platform's checker reads the real gaps and refuses the file —
   * leaving somebody certain their 30fps video was rejected for being 30fps.
   * The average would agree with them and pass it through.
   */
  const effectiveRate = item.peakFrameRate ?? item.frameRate;
  if (effectiveRate !== undefined) {
    if (constraint.maxFrameRate !== undefined && effectiveRate > constraint.maxFrameRate) {
      issues.push(
        issue(
          'ERROR',
          'MEDIA_FRAME_RATE_TOO_HIGH',
          field,
          item.peakFrameRate !== undefined &&
            item.frameRate !== undefined &&
            item.peakFrameRate > item.frameRate + 1
            ? `This video varies between frame rates, peaking at ${effectiveRate}fps — above the ${constraint.maxFrameRate}fps limit. Re-export it at a constant frame rate.`
            : `This video is ${effectiveRate}fps, above the ${constraint.maxFrameRate}fps limit.`,
          { frameRate: effectiveRate, maxFrameRate: constraint.maxFrameRate },
        ),
      );
    }

    if (constraint.minFrameRate !== undefined && effectiveRate < constraint.minFrameRate) {
      issues.push(
        issue(
          'ERROR',
          'MEDIA_FRAME_RATE_TOO_LOW',
          field,
          `This video is ${effectiveRate}fps, below the ${constraint.minFrameRate}fps minimum.`,
          { frameRate: effectiveRate, minFrameRate: constraint.minFrameRate },
        ),
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

  // The text the platform will actually receive, where hashtags and the link
  // are written into it rather than sent alongside.
  const published = publishedTextFor(draft, capabilities);

  // A thread is checked post by post: each part against the limit and the
  // link count, and the whole against the most posts one thread may be.
  const threaded = draft.thread === true && capabilities.thread.supported;
  const parts = threaded ? threadPartsFor(draft, capabilities) : [];

  if (draft.thread === true && !capabilities.thread.supported) {
    issues.push(
      issue('ERROR', 'THREAD_UNSUPPORTED', 'thread', 'This platform cannot publish a thread.'),
    );
  }

  if (capabilities.text.supported && threaded) {
    const maxPosts = capabilities.thread.maxPosts ?? 1;
    if (parts.length > maxPosts) {
      issues.push(
        issue(
          'ERROR',
          'THREAD_TOO_LONG',
          'body',
          `This would be a thread of ${parts.length} posts; the most is ${maxPosts}. Shorten the text.`,
          { count: parts.length, maxPosts },
        ),
      );
    }

    // Cannot happen with a well-behaved split. Checked anyway, because the
    // platform refusing part four of a live thread is far worse than this.
    parts.forEach((part, index) => {
      const count = countCharacters(part, capabilities);
      if (count > capabilities.text.maxLength) {
        issues.push(
          issue(
            'ERROR',
            'TEXT_TOO_LONG',
            'body',
            `Post ${index + 1} of the thread is longer than the platform allows.`,
            { count, maxLength: capabilities.text.maxLength, part: index + 1 },
          ),
        );
      }
    });
  } else if (capabilities.text.supported) {
    const count = countCharacters(published, capabilities);
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
  // A dedicated linkUrl attachment on a platform without link support is rejected.
  // When a platform does not support clickable links (e.g. TikTok, Instagram),
  // URLs in the text/caption are treated as normal plain text rather than
  // flagging them as an unsupported link error, so authors can include links
  // in captions without issue.
  if (draft.linkUrl && !capabilities.link.supported) {
    issues.push(
      issue('ERROR', 'LINK_UNSUPPORTED', 'linkUrl', 'Links are not supported on this platform.'),
    );
  } else if (capabilities.link.supported && threaded) {
    parts.forEach((part, index) => {
      const separateLink = index === 0 && draft.linkUrl && !capabilities.text.composedText ? 1 : 0;
      const count = (part.match(URL_PATTERN) ?? []).length + separateLink;
      if (count > capabilities.link.maxCount) {
        issues.push(
          issue(
            'ERROR',
            'TOO_MANY_LINKS',
            'linkUrl',
            `Post ${index + 1} of the thread has more links than this platform allows.`,
            { count, maxCount: capabilities.link.maxCount, part: index + 1 },
          ),
        );
      }
    });
  } else if (capabilities.link.supported) {
    const bodyLinks = published.match(URL_PATTERN) ?? [];
    const totalLinks =
      bodyLinks.length + (draft.linkUrl && !capabilities.text.composedText ? 1 : 0);
    if (totalLinks > capabilities.link.maxCount) {
      issues.push(
        issue('ERROR', 'TOO_MANY_LINKS', 'linkUrl', 'This platform allows fewer links.', {
          count: totalLinks,
          maxCount: capabilities.link.maxCount,
        }),
      );
    }
  }

  // ── Media ───────────────────────────────────────────────────────────────
  if (capabilities.media.required && media.length === 0) {
    issues.push(
      issue('ERROR', 'MEDIA_REQUIRED', 'media', 'This platform requires an image or video.'),
    );
  }

  // A thread spreads its attachments over its posts, and each post is held to
  // the platform's rules on its own (D-124).
  const attachmentSets =
    threaded && parts.length > 1
      ? assignThreadMedia(media, parts.length, draft.threadMedia, capabilities.media)
      : [media];
  attachmentSets.forEach((set, index) => {
    issues.push(
      ...attachmentSetIssues(capabilities, set, attachmentSets.length > 1 ? index + 1 : undefined),
    );
  });

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
          'Too soon for the platform to hold this post; it will be published by Social Square instead.',
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
          'Further ahead than the platform will hold; Social Square will publish it at the right time.',
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

/**
 * The rules for what one post may carry, applied to one set of attachments:
 * how many, which kinds must be alone, and whether kinds may be mixed. `part`
 * names the post of a thread the set belongs to.
 */
function attachmentSetIssues(
  capabilities: PlatformCapabilities,
  media: readonly DraftMedia[],
  part?: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const where = part === undefined ? '' : `Post ${part} of the thread: `;
  const partMeta: Record<string, number> = part === undefined ? {} : { part };

  if (media.length > capabilities.media.maxAttachments) {
    issues.push(
      issue(
        'ERROR',
        'TOO_MANY_ATTACHMENTS',
        'media',
        `${where}Too many attachments for this platform.`,
        { count: media.length, maxAttachments: capabilities.media.maxAttachments, ...partMeta },
      ),
    );
  }

  const solo = media.find((m) => capabilities.media.soloKinds.includes(m.kind));
  if (solo && media.length > 1) {
    issues.push(
      issue(
        'ERROR',
        'SOLO_MEDIA_KIND',
        'media',
        solo.kind === 'VIDEO'
          ? `${where}A video has to be the only attachment on this platform.`
          : `${where}A GIF has to be the only attachment on this platform.`,
        { kind: solo.kind, ...partMeta },
      ),
    );
  }

  const kinds = new Set(media.map((m) => m.kind));
  if (kinds.size > 1 && !capabilities.media.allowsMixedKinds) {
    issues.push(
      issue(
        'ERROR',
        'MIXED_MEDIA_UNSUPPORTED',
        'media',
        `${where}Images and video cannot be combined here.`,
        partMeta,
      ),
    );
  }

  return issues;
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
      reason:
        'This post was created outside Social Square, so the platform will not let us edit it.',
    };
  }
  return { allowed: true };
}

export const errorsOnly = (result: ValidationResult): ValidationIssue[] =>
  result.issues.filter((i) => i.severity === 'ERROR');
