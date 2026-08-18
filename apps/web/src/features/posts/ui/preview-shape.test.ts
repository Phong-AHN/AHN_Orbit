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

  /**
   * TikTok, which the generic fallback described as a Facebook post.
   *
   * Before this it fell through to `GENERIC`: caption above a landscape frame
   * with clickable links, when a TikTok post is a full-screen vertical video
   * with the caption over it and links that do nothing. A preview that
   * confidently draws the wrong platform is worse than no preview.
   */
  it('draws TikTok as vertical, with the caption over the video', () => {
    const shape = previewShape('TIKTOK');

    expect(shape.aspect).toBe('portrait');
    expect(shape.captionBelow).toBe(false);
    expect(shape.linksClickable).toBe(false);
    // Folds sooner than Facebook, later than nothing.
    expect(shape.foldAt).toBeLessThan(previewShape('FACEBOOK').foldAt);
  });

  it('says a TikTok link is not clickable, as on Instagram', () => {
    expect(
      previewNotes({ ...base, platform: 'TIKTOK', text: 'shop at https://example.com' }),
    ).toContainEqual(expect.stringContaining('not clickable'));
  });

  it('warns that TikTok fills a vertical screen rather than cropping square', () => {
    const notes = previewNotes({ ...base, platform: 'TIKTOK', imageCount: 1 });

    expect(notes).toContainEqual(expect.stringContaining('vertical'));
    expect(notes).not.toContainEqual(expect.stringContaining('square'));
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
