import { describe, expect, it } from 'vitest';

import {
  describeConstraint,
  describeFacts,
  describeMediaNeed,
  formatAspectRatio,
  formatBytes,
  formatDuration,
  formatType,
  mediaIndexFromField,
  pinMediaIssues,
  worstSeverity,
  type MediaCapabilityView,
  type MediaConstraintView,
} from './facts';

describe('mediaIndexFromField', () => {
  it('reads the index the validation engine put in the field name', () => {
    expect(mediaIndexFromField('media[0]')).toBe(0);
    expect(mediaIndexFromField('media[2]')).toBe(2);
    expect(mediaIndexFromField('media[11]')).toBe(11);
  });

  /**
   * A platform that requires media and got none reports `media`, not
   * `media[0]` — there is no attachment to blame. That issue belongs above the
   * list, so it must not be pinned to the first file.
   */
  it('returns null for an issue about the attachment set as a whole', () => {
    expect(mediaIndexFromField('media')).toBeNull();
  });

  it('returns null for fields that are not about media', () => {
    expect(mediaIndexFromField('body')).toBeNull();
    expect(mediaIndexFromField('linkUrl')).toBeNull();
    expect(mediaIndexFromField('firstComment')).toBeNull();
  });

  it('does not half-match a field that merely starts like one', () => {
    expect(mediaIndexFromField('media[2].altText')).toBeNull();
    expect(mediaIndexFromField('mediaGroup[2]')).toBeNull();
    expect(mediaIndexFromField('media[]')).toBeNull();
    expect(mediaIndexFromField('media[-1]')).toBeNull();
  });
});

describe('formatBytes', () => {
  /**
   * The real figures from the Facebook descriptor, which stores 8 MiB and
   * 100 MiB — exactly the "8 MB" and "100 MB" the platform documents. Decimal
   * division rendered those as 8.4 and 104.9, so every published limit on
   * screen was a number nobody could look up.
   */
  it('shows a platform limit as the platform writes it', () => {
    expect(formatBytes(8 * 1024 * 1024)).toBe('8 MB');
    expect(formatBytes(100 * 1024 * 1024)).toBe('100 MB');
    expect(formatBytes(4 * 1024 * 1024 * 1024)).toBe('4 GB');
  });

  it('scales down to the unit that fits', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(200 * 1024)).toBe('200 KB');
  });

  it('keeps a fraction that carries information', () => {
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
  });
});

describe('formatDuration', () => {
  it('reads as minutes and seconds', () => {
    expect(formatDuration(5_000)).toBe('0:05');
    expect(formatDuration(90_000)).toBe('1:30');
    expect(formatDuration(600_000)).toBe('10:00');
  });

  it('pads the seconds so 1:05 is never shown as 1:5', () => {
    expect(formatDuration(65_000)).toBe('1:05');
  });
});

describe('formatAspectRatio', () => {
  it('uses the name the platform states its own limit in', () => {
    expect(formatAspectRatio(1)).toBe('1:1');
    expect(formatAspectRatio(1080 / 1920)).toBe('9:16');
    expect(formatAspectRatio(1080 / 1350)).toBe('4:5');
  });

  /**
   * 1.91:1 is Instagram's widest and 16:9 is 1.78 — 7% apart. A tolerance loose
   * enough to confuse them would state a limit the platform does not have.
   */
  it('does not round a distinct ratio into a neighbouring name', () => {
    expect(formatAspectRatio(1.91)).toBe('1.91:1');
  });

  it('falls back to a number for a ratio with no common name', () => {
    expect(formatAspectRatio(2.5)).toBe('2.5:1');
    expect(formatAspectRatio(0.4)).toBe('1:2.5');
  });

  /** Facebook's 0.5–2.0 bounds rendered as "1:2.00" and "2.00:1". */
  it('does not say 2:1 the long way round', () => {
    expect(formatAspectRatio(2)).toBe('2:1');
    expect(formatAspectRatio(0.5)).toBe('1:2');
  });
});

describe('formatType', () => {
  it('shows the extension a person recognises, not the MIME type', () => {
    expect(formatType('video/quicktime')).toBe('MOV');
    expect(formatType('image/jpeg')).toBe('JPG');
    expect(formatType('image/png')).toBe('PNG');
    expect(formatType('video/mp4')).toBe('MP4');
  });
});

describe('describeFacts', () => {
  it('states the verified numbers about one file', () => {
    expect(
      describeFacts({
        kind: 'IMAGE',
        mimeType: 'image/jpeg',
        width: 1080,
        height: 1080,
        sizeBytes: 2_516_582,
      }),
    ).toEqual(['1080 × 1080 (1:1)', '2.4 MB']);
  });

  /**
   * The reason this module exists. A phone shoots variable frame rate: the file
   * averages 30 and spikes past the ceiling, and the platform checks the spike.
   * Showing only the average leaves somebody certain their 30fps video was
   * refused for being 30fps.
   */
  it('shows the peak frame rate beside the average when they differ', () => {
    const parts = describeFacts({
      kind: 'VIDEO',
      mimeType: 'video/mp4',
      frameRate: 30,
      peakFrameRate: 62,
    });

    expect(parts).toContain('30 fps average, 62 fps peak');
  });

  it('says it once when the file is genuinely constant frame rate', () => {
    const parts = describeFacts({
      kind: 'VIDEO',
      mimeType: 'video/mp4',
      frameRate: 30,
      peakFrameRate: 30,
    });

    expect(parts).toContain('30 fps');
  });

  /** Measurement noise is not variable frame rate, and should not read as it. */
  it('does not call a rounding difference a peak', () => {
    const parts = describeFacts({
      kind: 'VIDEO',
      mimeType: 'video/mp4',
      frameRate: 29.97,
      peakFrameRate: 30,
    });

    expect(parts).toContain('30 fps');
  });

  /**
   * Probing can fail, and an unmeasured file is not a 0×0 one. An absent fact
   * produces no claim at all.
   */
  it('omits what was never measured rather than reporting zero', () => {
    expect(describeFacts({ kind: 'IMAGE', mimeType: 'image/png' })).toEqual([]);
    expect(
      describeFacts({ kind: 'IMAGE', mimeType: 'image/png', width: 800, height: 0 }),
    ).toEqual([]);
  });
});

const videoConstraint: MediaConstraintView = {
  mimeTypes: ['video/mp4'],
  maxBytes: 500 * 1024 * 1024,
  minDurationMs: 3_000,
  maxDurationMs: 600_000,
  minFrameRate: 23,
  maxFrameRate: 60,
};

describe('describeConstraint', () => {
  it('states each limit on its own line', () => {
    expect(describeConstraint(videoConstraint)).toEqual([
      'Format: MP4',
      'Up to 500 MB',
      'Length 0:03–10:00',
      'Frame rate 23–60 fps, measured at the peak',
    ]);
  });

  /** The frame-rate line names the peak, because that is what is checked. */
  it('names the peak on a one-sided frame-rate ceiling', () => {
    expect(
      describeConstraint({ mimeTypes: [], maxBytes: 1024 * 1024, maxFrameRate: 60 }),
    ).toContain('At most 60 fps, measured at the peak');
  });

  it('states aspect bounds in the form the platform publishes them', () => {
    expect(
      describeConstraint({
        mimeTypes: ['image/jpeg'],
        maxBytes: 8 * 1024 * 1024,
        minAspectRatio: 4 / 5,
        maxAspectRatio: 1.91,
      }),
    ).toContain('Aspect 4:5–1.91:1');
  });

  /** A platform that states nothing about duration should say nothing. */
  it('writes no line for a limit the platform does not set', () => {
    const lines = describeConstraint({ mimeTypes: ['image/png'], maxBytes: 5 * 1024 * 1024 });

    expect(lines).toEqual(['Format: PNG', 'Up to 5 MB']);
  });
});

const capability = (over: Partial<MediaCapabilityView> = {}): MediaCapabilityView => ({
  image: { mimeTypes: ['image/jpeg'], maxBytes: 8 * 1024 * 1024 },
  video: videoConstraint,
  gif: null,
  maxAttachments: 10,
  allowsMixedKinds: false,
  required: false,
  altText: true,
  ...over,
});

describe('describeMediaNeed', () => {
  it('leads with whether an attachment is required', () => {
    expect(describeMediaNeed(capability({ required: true }))).toBe(
      'Needs images or video — up to 10 attachments.',
    );
    expect(describeMediaNeed(capability())).toBe(
      'Optional images or video — up to 10 attachments.',
    );
  });

  /** YouTube has no image post. The composer used to accept one. */
  it('names only the kinds the platform actually takes', () => {
    expect(describeMediaNeed(capability({ image: null, required: true, maxAttachments: 1 }))).toBe(
      'Needs video — one attachment.',
    );
  });

  it('says plainly when a platform takes no attachment at all', () => {
    expect(
      describeMediaNeed(capability({ image: null, video: null, maxAttachments: 0 })),
    ).toBe('Text only — no attachments.');
  });

  /**
   * A descriptor that sets a `gif` constraint accepts a GIF on terms of its
   * own. Ignoring that field would report the platform as taking no attachment
   * at all — the same class of mistake as claiming YouTube takes images.
   */
  it('names a GIF-only platform rather than calling it text only', () => {
    expect(
      describeMediaNeed(
        capability({
          image: null,
          video: null,
          gif: { mimeTypes: ['image/gif'], maxBytes: 8 * 1024 * 1024 },
          maxAttachments: 1,
        }),
      ),
    ).toBe('Optional GIFs — one attachment.');
  });
});

describe('pinMediaIssues', () => {
  const tooLong = {
    severity: 'ERROR' as const,
    field: 'media[0]',
    message: 'The video is longer than TikTok allows.',
  };
  const tooWide = {
    severity: 'WARNING' as const,
    field: 'media[1]',
    message: 'This image will be cropped.',
  };
  const bodyTooLong = {
    severity: 'ERROR' as const,
    field: 'body',
    message: 'The text is too long.',
  };

  it('pins each issue to the attachment the engine named', () => {
    const pinned = pinMediaIssues([], [{ accountName: 'AHN on TikTok', issues: [tooLong, tooWide] }]);

    expect(pinned).toEqual([
      {
        severity: 'ERROR',
        message: tooLong.message,
        where: 'AHN on TikTok',
        index: 0,
      },
      {
        severity: 'WARNING',
        message: tooWide.message,
        where: 'AHN on TikTok',
        index: 1,
      },
    ]);
  });

  /**
   * The Checks card already lists every issue. A text-length error repeated
   * under a photograph is noise, and reads as though the photograph caused it.
   */
  it('leaves out issues that are not about media', () => {
    const pinned = pinMediaIssues(
      [bodyTooLong],
      [{ accountName: 'AHN on TikTok', issues: [bodyTooLong, tooLong] }],
    );

    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.index).toBe(0);
  });

  /**
   * MEDIA_REQUIRED carries `field: 'media'`. Pinning it to attachment 1 would
   * blame a file for the absence of a file — and when media is required there
   * is no attachment 1 to blame.
   */
  it('does not pin a set-level issue to the first file', () => {
    const pinned = pinMediaIssues(
      [],
      [
        {
          accountName: 'AHN on Instagram',
          issues: [
            {
              severity: 'ERROR',
              field: 'media',
              message: 'This platform requires an image or video.',
            },
          ],
        },
      ],
    );

    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.index).toBeNull();
  });

  it('keeps post-level issues separate from the account that raised one', () => {
    const pinned = pinMediaIssues(
      [{ severity: 'ERROR', field: 'media[0]', message: 'That file was removed.' }],
      [{ accountName: 'AHN on TikTok', issues: [tooLong] }],
    );

    expect(pinned.map((issue) => issue.where)).toEqual([null, 'AHN on TikTok']);
  });

  it('reports the same file once per account that objected', () => {
    const pinned = pinMediaIssues(
      [],
      [
        { accountName: 'AHN on TikTok', issues: [tooLong] },
        { accountName: 'AHN on Instagram', issues: [{ ...tooLong, message: 'Too long for Reels.' }] },
      ],
    );

    expect(pinned.filter((issue) => issue.index === 0)).toHaveLength(2);
  });
});

describe('worstSeverity', () => {
  it('lets an error outrank a warning on the same file', () => {
    expect(
      worstSeverity([
        { severity: 'WARNING', message: 'a', where: null, index: 0 },
        { severity: 'ERROR', message: 'b', where: null, index: 0 },
      ]),
    ).toBe('ERROR');
  });

  it('is null for a file nothing was said about', () => {
    expect(worstSeverity([])).toBeNull();
  });
});
