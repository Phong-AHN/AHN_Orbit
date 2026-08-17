import { describe, expect, it } from 'vitest';
import { previewNotes, previewShape } from './preview-shape';

/**
 * The feed sketch (SRS §9).
 *
 * Only the pure half is worth testing, and it is worth testing for one reason:
 * every string here is a claim about what will happen after publishing, and a
 * claim that is wrong is worse than no claim at all. The rendering is chrome.
 */

const base = { text: '', hasMedia: true, imageCount: 1, mediaRequired: false };

describe('what a feed does to a post', () => {
  it('folds an Instagram caption far earlier than a Facebook one', () => {
    const caption = 'x'.repeat(200);

    expect(previewNotes({ ...base, platform: 'INSTAGRAM', text: caption })).toContainEqual(
      expect.stringContaining('folds'),
    );
    expect(previewNotes({ ...base, platform: 'FACEBOOK', text: caption })).not.toContainEqual(
      expect.stringContaining('folds'),
    );
  });

  it('says an Instagram link is not clickable, and stays quiet about a Facebook one', () => {
    const withLink = 'Read more at https://example.com/thing';

    expect(previewNotes({ ...base, platform: 'INSTAGRAM', text: withLink })).toContainEqual(
      expect.stringContaining('not clickable'),
    );
    expect(previewNotes({ ...base, platform: 'FACEBOOK', text: withLink })).not.toContainEqual(
      expect.stringContaining('not clickable'),
    );
  });

  it('does not invent a link where there is only prose about one', () => {
    const notALink = 'Send them to our website and mention the offer';

    expect(previewNotes({ ...base, platform: 'INSTAGRAM', text: notALink })).not.toContainEqual(
      expect.stringContaining('not clickable'),
    );
  });

  it('warns about the square crop only when there is an image to crop', () => {
    expect(previewNotes({ ...base, platform: 'INSTAGRAM', imageCount: 1 })).toContainEqual(
      expect.stringContaining('square'),
    );
    expect(
      previewNotes({ ...base, platform: 'INSTAGRAM', imageCount: 0, hasMedia: false }),
    ).not.toContainEqual(expect.stringContaining('square'));
  });

  /**
   * `mediaRequired` comes from the provider layer, never from the table in this
   * file — the preview must not hold a second opinion about what a platform
   * allows.
   */
  it('repeats what the capability says about media, rather than deciding it', () => {
    expect(
      previewNotes({ ...base, platform: 'INSTAGRAM', hasMedia: false, mediaRequired: true }),
    ).toContainEqual(expect.stringContaining('cannot post without'));

    expect(
      previewNotes({ ...base, platform: 'INSTAGRAM', hasMedia: false, mediaRequired: false }),
    ).not.toContainEqual(expect.stringContaining('cannot post without'));
  });

  it('says nothing at all about a short, plain post', () => {
    expect(previewNotes({ ...base, platform: 'FACEBOOK', text: 'Morning, everyone.' })).toEqual([]);
  });

  /** A platform nobody has taught it about still draws, and claims nothing. */
  it('falls back to a generic shape for an unknown platform', () => {
    const shape = previewShape('SOME_FUTURE_NETWORK');

    expect(shape.captionBelow).toBe(false);
    expect(shape.linksClickable).toBe(true);
    expect(previewNotes({ ...base, platform: 'SOME_FUTURE_NETWORK', text: 'hi' })).toEqual([]);
  });

  it('puts the caption under the picture on Instagram and over it on Facebook', () => {
    expect(previewShape('INSTAGRAM').captionBelow).toBe(true);
    expect(previewShape('FACEBOOK').captionBelow).toBe(false);
  });
});
