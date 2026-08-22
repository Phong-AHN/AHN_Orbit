/**
 * How a feed *draws* a post — and only that (SRS §9).
 *
 * Split out from `preview.tsx` deliberately, and the split is the point:
 * everything here is a **claim about what a reader will see**, it is pure, and
 * it is testable. A claim that is wrong is worse than no claim, so these are
 * asserted rather than eyeballed.
 *
 * This is **presentation, not capability**. Real platform facts — the character
 * ceiling, whether media is required, whether a first comment exists — come
 * from the provider layer through `CapabilitySummary`, and the preview only
 * repeats them. Nothing in this file may decide whether a post can publish:
 * `/validate` runs the real engine server-side, and a second opinion rendered
 * in the browser is exactly the drift that engine exists to prevent.
 *
 * Meta moves these numbers around without telling anybody, which is a further
 * reason they must never be load-bearing.
 */

export interface PreviewShape {
  /** Where the text sits relative to the media. */
  captionBelow: boolean;
  /** Roughly where the feed folds the text behind a "more" control. */
  foldAt: number;
  foldLabel: string;
  /** How the feed frames the first attachment. */
  aspect: 'square' | 'natural' | 'portrait';
  /** Whether a URL in the caption is clickable in the feed. */
  linksClickable: boolean;
}

const GENERIC: PreviewShape = {
  captionBelow: false,
  foldAt: 400,
  foldLabel: 'See more',
  aspect: 'natural',
  linksClickable: true,
};

const SHAPES: Record<string, PreviewShape> = {
  FACEBOOK: { ...GENERIC },
  /**
   * TikTok, which the generic fallback got wrong in every respect.
   *
   * A TikTok post is a full-screen vertical video with the caption laid over
   * the bottom of it, folded after about a line. Rendered as the generic shape
   * — caption above a 4:3 frame, links clickable — it looked like a Facebook
   * post, which is the one thing a preview must not do.
   */
  TIKTOK: {
    captionBelow: false,
    // Roughly a line over the video before "more".
    foldAt: 100,
    foldLabel: 'more',
    // Full-screen vertical. A landscape sketch would misrepresent the crop.
    aspect: 'portrait',
    // A URL in a TikTok caption is plain text, as on Instagram.
    linksClickable: false,
  },
  /**
   * YouTube, where the "caption" is two different things.
   *
   * A viewer sees the **title** under the player and nothing else until they
   * expand the description, so the fold is the title's own 100-character
   * ceiling rather than a feed's truncation. Links in a description really are
   * clickable, which is the one respect in which the generic shape was right.
   */
  YOUTUBE: {
    captionBelow: true,
    foldAt: 100,
    foldLabel: 'more',
    // 16:9 is what a player draws, however the file was shot. A vertical file
    // becomes a Short, which is a different frame — and not something this
    // sketch should promise either way.
    aspect: 'natural',
    linksClickable: true,
  },
  /**
   * Pinterest, which is a tall card and nothing like a feed post.
   *
   * The recommended 2:3 is the whole visual language of the platform, and a
   * landscape sketch would misrepresent the crop badly. A URL in a description
   * is plain text — the pin's destination link is a separate field, which is
   * worth knowing before somebody writes their call to action into the body.
   */
  PINTEREST: {
    captionBelow: true,
    foldAt: 100,
    foldLabel: 'more',
    aspect: 'portrait',
    linksClickable: false,
  },
  INSTAGRAM: {
    captionBelow: true,
    // The feed shows about one line of caption. The exact figure moves; the
    // point it makes — put the hook first — does not.
    foldAt: 125,
    foldLabel: 'more',
    aspect: 'square',
    // A link in an Instagram caption is plain text. Worth saying, because a
    // post whose entire call to action is a URL will simply not work.
    linksClickable: false,
  },
};

const URL_PATTERN = /\bhttps?:\/\/\S+/i;

/** A platform nobody has taught this about still draws, and claims nothing. */
export function previewShape(platform: string): PreviewShape {
  return SHAPES[platform] ?? GENERIC;
}

/**
 * The things somebody would otherwise only find out after publishing.
 *
 * **Never an error.** These are observations; a red warning here that
 * `/validate` disagrees with would teach people to ignore the one that matters.
 */
export function previewNotes(input: {
  platform: string;
  text: string;
  hasMedia: boolean;
  imageCount: number;
  /** From the capability summary — the preview never decides this itself. */
  mediaRequired: boolean;
}): string[] {
  const shape = previewShape(input.platform);
  const text = input.text.trim();
  const notes: string[] = [];

  if (text.length > shape.foldAt) {
    notes.push(`The feed folds this after about ${shape.foldAt} characters.`);
  }

  if (!shape.linksClickable && URL_PATTERN.test(text)) {
    notes.push('A link here is plain text — it is not clickable in the feed.');
  }

  if (input.imageCount > 0) {
    if (shape.aspect === 'square') notes.push('The feed crops this to a square.');
    if (shape.aspect === 'portrait') notes.push('The feed fills a vertical screen with this.');
  }

  if (input.mediaRequired && !input.hasMedia) {
    notes.push('This account cannot post without an image or video.');
  }

  return notes;
}
