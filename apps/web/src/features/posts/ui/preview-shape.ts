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
  /** How the feed crops the first image. */
  aspect: 'square' | 'natural';
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

  if (shape.aspect === 'square' && input.imageCount > 0) {
    notes.push('The feed crops this to a square.');
  }

  if (input.mediaRequired && !input.hasMedia) {
    notes.push('This account cannot post without an image or video.');
  }

  return notes;
}
