import { describe, expect, it } from 'vitest';
import { facebookPageCapabilities } from '@orbit/providers/facebook';
import { instagramCapabilities } from '@orbit/providers/instagram';
import { tiktokCapabilities } from '@orbit/providers/tiktok';
import { youtubeCapabilities } from '@orbit/providers/youtube';
import { pinterestCapabilities } from '@orbit/providers/pinterest';
import { threadsCapabilities } from '@orbit/providers/threads';
import { linkedinCapabilities } from '@orbit/providers/linkedin';
import type { PlatformCapabilities } from '@orbit/providers';
import { describeConstraint, describeMediaNeed, type MediaCapabilityView } from './facts';

/**
 * The requirement text against every real capability descriptor.
 *
 * The unit tests in `facts.test.ts` use fixtures, which is the right shape for
 * checking the formatting rules — and it is also exactly how a formatter can
 * pass everything and still read like nonsense in the product. Running the same
 * functions over the descriptors that actually ship is what caught both of the
 * display bugs this feature had:
 *
 * - **`Up to 8.4 MB`.** Facebook publishes an 8 MB image limit, the descriptor
 *   stores it as 8 MiB, and dividing by a million displayed a number nobody can
 *   look up. Every published limit on screen was unrecognisable.
 * - **`Aspect 1:2.00–2.00:1`**, which says 2:1 the long way round.
 *
 * It deliberately asserts **shape, not wording**. Locking the exact sentence
 * would fail every time a platform legitimately changes a limit, and that
 * failure would say "the text changed" about a change that was correct.
 *
 * So the guards are properties: no line may be degenerate (a `NaN`, an
 * `undefined`, a `0 MB` ceiling, a dangling separator), a whole-mebibyte limit
 * must render as a whole number, and a constrained frame rate must say it is
 * the peak. The first version of this file asserted only the degenerate cases,
 * which would have let the decimal bug straight back through — "8.4 MB" has no
 * hole and no zero in it.
 */

const descriptors: Array<[string, PlatformCapabilities]> = [
  ['FACEBOOK', facebookPageCapabilities('v21.0')],
  ['INSTAGRAM', instagramCapabilities('v21.0')],
  ['TIKTOK', tiktokCapabilities('v2')],
  ['YOUTUBE', youtubeCapabilities('v3')],
  ['PINTEREST', pinterestCapabilities('v5')],
  ['THREADS', threadsCapabilities('v1.0')],
  ['LINKEDIN', linkedinCapabilities('202608')],
];

function view(c: PlatformCapabilities): MediaCapabilityView {
  return {
    image: c.media.image,
    video: c.media.video,
    gif: c.media.gif,
    maxAttachments: c.media.maxAttachments,
    allowsMixedKinds: c.media.allowsMixedKinds,
    required: c.media.required,
    altText: c.media.altText,
  };
}

describe.each(descriptors)('%s requirement text', (_name, capabilities) => {
  const media = view(capabilities);

  const lines = [
    ...(media.image ? describeConstraint(media.image) : []),
    ...(media.video ? describeConstraint(media.video) : []),
    ...(media.gif ? describeConstraint(media.gif) : []),
  ];

  it('says in one sentence what the platform takes', () => {
    const need = describeMediaNeed(media);

    expect(need).not.toMatch(/undefined|NaN|null/);
    // Either it names a kind, or it says plainly that there is no attachment.
    expect(need).toMatch(/images|video|Text only/);
  });

  it('produces no line with a hole in it', () => {
    for (const line of lines) {
      expect(line).not.toMatch(/undefined|NaN|null/);
      expect(line.trim()).not.toBe('');
      // A dangling separator means a fragment was built from a missing value.
      expect(line).not.toMatch(/(^[—·–]|[—·–]$)/);
    }
  });

  /**
   * A ceiling that reads as zero would tell somebody no file can ever pass.
   * This is what a decimal divisor did to small limits.
   */
  it('never states a limit of zero', () => {
    for (const line of lines) {
      expect(line).not.toMatch(/\b0 (B|KB|MB|GB)\b/);
      expect(line).not.toMatch(/\b0\.0+ (KB|MB|GB)\b/);
    }
  });

  /**
   * A limit stored as a whole number of mebibytes is displayed as a whole
   * number — which is the assertion that actually catches the decimal bug,
   * rather than merely being motivated by it.
   *
   * Every real descriptor states its ceilings in binary multiples, because
   * that is how the platforms publish them. Dividing by a million turns 8 MiB
   * into "8.4 MB" and 100 MiB into "104.9 MB": no hole, no zero, nothing a
   * shape check would notice, and a figure that appears in no platform's
   * documentation. Asserting the *whole number* and not the exact text leaves
   * a platform free to change 8 MB to 12 MB without failing this.
   */
  it('shows a whole-mebibyte ceiling as a whole number', () => {
    const kinds = [media.image, media.video, media.gif].filter((c) => c !== null);

    for (const constraint of kinds) {
      if (constraint.maxBytes % (1024 * 1024) !== 0) continue;

      const line = describeConstraint(constraint).find((l) => l.startsWith('Up to '));
      expect(line).toMatch(/^Up to \d+ (MB|GB)$/);
    }
  });

  /** Every byte ceiling is stated, because it is the limit people hit first. */
  it('states a size ceiling for every kind it accepts', () => {
    const kinds = [media.image, media.video, media.gif].filter((c) => c !== null);

    for (const constraint of kinds) {
      expect(describeConstraint(constraint).some((line) => line.startsWith('Up to '))).toBe(true);
    }
  });

  /**
   * The frame-rate line has to name the peak wherever a descriptor sets one.
   * The average is what a file reports about itself and the peak is what the
   * platform checks; a line that says "60 fps" without saying which leaves the
   * one explanation that matters unsaid (**D-086**).
   */
  it('names the peak wherever a frame rate is constrained', () => {
    for (const constraint of [media.image, media.video, media.gif]) {
      if (!constraint) continue;
      if (constraint.minFrameRate === undefined && constraint.maxFrameRate === undefined) continue;

      const rateLine = describeConstraint(constraint).find((line) => line.includes('fps'));
      expect(rateLine).toBeDefined();
      expect(rateLine).toContain('peak');
    }
  });
});
