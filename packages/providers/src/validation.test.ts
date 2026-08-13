import { describe, expect, it } from 'vitest';
import { defineCapabilities, type PlatformCapabilities } from './capabilities.js';
import { canEditPublished, countCharacters, errorsOnly, validateDraft } from './validation.js';
import type { DraftMedia } from './validation.js';

/**
 * Validation is driven entirely by the descriptor, so these tests build
 * synthetic capability sets rather than using a real platform's. If a rule can
 * only be expressed by naming a platform, it does not belong in the engine.
 */

const base = {
  platform: 'FACEBOOK',
  accountType: null,
  apiVersion: 'test-1',
  verifiedOn: '2026-08-12',
  text: { supported: true, maxLength: 100, allowsEmptyWithMedia: true },
  link: { supported: true, maxCount: 2 },
  media: {
    image: {
      mimeTypes: ['image/jpeg', 'image/png'],
      maxBytes: 1_000_000,
      minWidth: 100,
      minHeight: 100,
      minAspectRatio: 0.5,
      maxAspectRatio: 2,
    },
    video: { mimeTypes: ['video/mp4'], maxBytes: 10_000_000, maxDurationMs: 60_000 },
    gif: null,
    maxAttachments: 3,
    allowsMixedKinds: false,
    carousel: true,
    altText: true,
    required: false,
  },
  hashtags: { supported: true, maxCount: 5 },
  mentions: { supported: true },
  firstComment: { supported: true, maxLength: 50 },
  scheduling: { providerSide: true, minLeadMs: 600_000, maxLeadMs: 2_592_000_000 },
  lifecycle: { edit: true, editOwnPostsOnly: true, delete: true, readStatus: true },
  publishing: { idempotencyKey: false, reconcilable: true, rateLimit: null },
  analytics: { post: true, account: true, metrics: ['views'], deprecatedMetrics: ['impressions'] },
  webhooks: { supported: false },
};

const caps = (overrides: Record<string, unknown> = {}): PlatformCapabilities =>
  defineCapabilities({ ...base, ...overrides });

const image = (over: Partial<DraftMedia> = {}): DraftMedia => ({
  id: 'm1',
  kind: 'IMAGE',
  mimeType: 'image/jpeg',
  sizeBytes: 5000,
  width: 800,
  height: 600,
  ...over,
});

const codes = (result: ReturnType<typeof validateDraft>) => result.issues.map((i) => i.code);

describe('text', () => {
  it('accepts a body within the limit', () => {
    expect(validateDraft(caps(), { body: 'Hello world' }).valid).toBe(true);
  });

  it('rejects a body over the limit', () => {
    const result = validateDraft(caps(), { body: 'a'.repeat(101) });
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('TEXT_TOO_LONG');
  });

  it('warns near the limit without failing', () => {
    const result = validateDraft(caps(), { body: 'a'.repeat(95) });
    expect(result.valid).toBe(true);
    expect(codes(result)).toContain('TEXT_NEAR_LIMIT');
  });

  it('counts an emoji as one character, not two', () => {
    // '👍' is two UTF-16 units; counting units would reject posts the platform
    // accepts, which is a real and very confusing bug for users.
    const body = '👍'.repeat(100);
    expect(countCharacters(body, caps())).toBe(100);
    expect(validateDraft(caps(), { body }).valid).toBe(true);
  });

  it('applies a fixed link cost where the platform bills one', () => {
    const withCost = caps({ text: { supported: true, maxLength: 100, linkCharacterCost: 23 } });
    const body = `Look: https://example.com/a/very/long/path/that/would/otherwise/count/for/lots`;
    expect(countCharacters(body, withCost)).toBe([...'Look: '].length + 23);
  });

  it('rejects an entirely empty post', () => {
    const result = validateDraft(caps(), { body: '   ' });
    expect(codes(result)).toContain('POST_EMPTY');
  });

  it('allows media with no caption when the platform permits it', () => {
    expect(validateDraft(caps(), { body: '', media: [image()] }).valid).toBe(true);
  });

  it('requires a caption when the platform demands one', () => {
    const strict = caps({ text: { supported: true, maxLength: 100, allowsEmptyWithMedia: false } });
    const result = validateDraft(strict, { body: '', media: [image()] });
    expect(codes(result)).toContain('TEXT_REQUIRED_WITH_MEDIA');
  });
});

describe('links', () => {
  it('counts links in the body as well as the link field', () => {
    const result = validateDraft(caps(), {
      body: 'See https://a.test and https://b.test',
      linkUrl: 'https://c.test',
    });
    expect(codes(result)).toContain('TOO_MANY_LINKS');
  });

  it('rejects any link where links are unsupported', () => {
    const noLinks = caps({ link: { supported: false, maxCount: 0 } });
    const result = validateDraft(noLinks, { body: 'go to https://a.test' });
    expect(codes(result)).toContain('LINK_UNSUPPORTED');
  });
});

describe('media', () => {
  it('rejects an unsupported mime type', () => {
    const result = validateDraft(caps(), {
      body: 'x',
      media: [image({ mimeType: 'image/tiff' })],
    });
    expect(codes(result)).toContain('MEDIA_TYPE_UNSUPPORTED');
  });

  it('rejects a file over the size limit', () => {
    const result = validateDraft(caps(), { body: 'x', media: [image({ sizeBytes: 2_000_000 })] });
    expect(codes(result)).toContain('MEDIA_TOO_LARGE');
  });

  it('rejects dimensions below the minimum', () => {
    const result = validateDraft(caps(), { body: 'x', media: [image({ width: 50, height: 50 })] });
    expect(codes(result)).toContain('MEDIA_TOO_NARROW');
  });

  it('rejects an aspect ratio outside the bounds', () => {
    const tooWide = validateDraft(caps(), {
      body: 'x',
      media: [image({ width: 3000, height: 500 })],
    });
    expect(codes(tooWide)).toContain('MEDIA_ASPECT_TOO_WIDE');

    const tooTall = validateDraft(caps(), {
      body: 'x',
      media: [image({ width: 500, height: 3000 })],
    });
    expect(codes(tooTall)).toContain('MEDIA_ASPECT_TOO_TALL');
  });

  it('accepts a standard 1080x1920 portrait against a 0.5 minimum', () => {
    // 1080/1920 = 0.5625; float noise must not push this below the bound.
    const portrait = caps({
      media: { ...base.media, image: { ...base.media.image, minWidth: 100, minHeight: 100 } },
    });
    const result = validateDraft(portrait, {
      body: 'x',
      media: [image({ width: 1080, height: 1920 })],
    });
    expect(errorsOnly(result)).toEqual([]);
  });

  it('rejects a video longer than allowed', () => {
    const result = validateDraft(caps(), {
      body: 'x',
      media: [
        { id: 'v', kind: 'VIDEO', mimeType: 'video/mp4', sizeBytes: 1000, durationMs: 90_000 },
      ],
    });
    expect(codes(result)).toContain('MEDIA_TOO_LONG_DURATION');
  });

  it('rejects a media kind the platform does not support at all', () => {
    const result = validateDraft(caps(), {
      body: 'x',
      media: [{ id: 'g', kind: 'GIF', mimeType: 'image/gif', sizeBytes: 1000 }],
    });
    expect(codes(result)).toContain('MEDIA_KIND_UNSUPPORTED');
  });

  it('rejects mixed kinds unless permitted', () => {
    const result = validateDraft(caps(), {
      body: 'x',
      media: [image(), { id: 'v', kind: 'VIDEO', mimeType: 'video/mp4', sizeBytes: 1000 }],
    });
    expect(codes(result)).toContain('MIXED_MEDIA_UNSUPPORTED');
  });

  it('rejects more attachments than allowed', () => {
    const result = validateDraft(caps(), {
      body: 'x',
      media: [image({ id: '1' }), image({ id: '2' }), image({ id: '3' }), image({ id: '4' })],
    });
    expect(codes(result)).toContain('TOO_MANY_ATTACHMENTS');
  });

  it('requires media when the platform demands it', () => {
    const required = caps({ media: { ...base.media, required: true } });
    expect(codes(validateDraft(required, { body: 'text only' }))).toContain('MEDIA_REQUIRED');
  });

  it('warns that alt text will be dropped rather than failing', () => {
    const noAlt = caps({ media: { ...base.media, altText: false } });
    const result = validateDraft(noAlt, { body: 'x', media: [image({ altText: 'a cat' })] });
    expect(result.valid).toBe(true);
    expect(codes(result)).toContain('ALT_TEXT_DROPPED');
  });

  it('names the offending attachment by index', () => {
    const result = validateDraft(caps(), {
      body: 'x',
      media: [image({ id: 'ok' }), image({ id: 'bad', sizeBytes: 9_000_000 })],
    });
    expect(result.issues.find((i) => i.code === 'MEDIA_TOO_LARGE')?.field).toBe('media[1]');
  });
});

describe('hashtags, mentions and first comment', () => {
  it('rejects too many hashtags', () => {
    const result = validateDraft(caps(), { body: 'x', hashtags: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(codes(result)).toContain('TOO_MANY_HASHTAGS');
  });

  it('warns rather than fails when hashtags are meaningless', () => {
    const noTags = caps({ hashtags: { supported: false } });
    const result = validateDraft(noTags, { body: 'x', hashtags: ['a'] });
    expect(result.valid).toBe(true);
    expect(codes(result)).toContain('HASHTAGS_UNSUPPORTED');
  });

  it('rejects a first comment where unsupported', () => {
    const none = caps({ firstComment: { supported: false } });
    const result = validateDraft(none, { body: 'x', firstComment: 'hi' });
    expect(codes(result)).toContain('FIRST_COMMENT_UNSUPPORTED');
  });

  it('rejects an over-long first comment', () => {
    const result = validateDraft(caps(), { body: 'x', firstComment: 'a'.repeat(51) });
    expect(codes(result)).toContain('FIRST_COMMENT_TOO_LONG');
  });
});

describe('provider-side scheduling window', () => {
  it('warns, never fails, when outside the provider window', () => {
    const soon = validateDraft(caps(), {
      body: 'x',
      scheduledFor: new Date(Date.now() + 60_000),
    });
    // Orbit schedules its own posts, so a provider window is advisory.
    expect(soon.valid).toBe(true);
    expect(codes(soon)).toContain('SCHEDULE_TOO_SOON');

    const far = validateDraft(caps(), {
      body: 'x',
      scheduledFor: new Date(Date.now() + 400 * 86_400_000),
    });
    expect(far.valid).toBe(true);
    expect(codes(far)).toContain('SCHEDULE_TOO_FAR');
  });

  it('says nothing when the provider does not schedule', () => {
    const noSchedule = caps({ scheduling: { providerSide: false } });
    const result = validateDraft(noSchedule, {
      body: 'x',
      scheduledFor: new Date(Date.now() + 60_000),
    });
    expect(codes(result)).not.toContain('SCHEDULE_TOO_SOON');
  });
});

describe('canEditPublished', () => {
  it('refuses when the platform has no edit API', () => {
    const noEdit = caps({ lifecycle: { edit: false, delete: true, readStatus: true } });
    expect(canEditPublished(noEdit, true).allowed).toBe(false);
  });

  it('refuses a post this app did not create, where the platform requires it', () => {
    const result = canEditPublished(caps(), false);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/created outside Orbit/);
  });

  it('allows editing our own post', () => {
    expect(canEditPublished(caps(), true).allowed).toBe(true);
  });
});

describe('descriptor integrity', () => {
  it('rejects attachments without any described media kind', () => {
    expect(() =>
      defineCapabilities({
        ...base,
        media: { ...base.media, image: null, video: null, gif: null, maxAttachments: 3 },
      }),
    ).toThrow(/no media kind is described/);
  });

  it('rejects a platform that supports neither text nor media', () => {
    expect(() =>
      defineCapabilities({
        ...base,
        text: { supported: false, maxLength: 1 },
        media: { ...base.media, maxAttachments: 0 },
      }),
    ).toThrow(/neither text nor media/);
  });

  it('rejects a metric listed as both available and deprecated', () => {
    expect(() =>
      defineCapabilities({
        ...base,
        analytics: { post: true, account: true, metrics: ['views'], deprecatedMetrics: ['views'] },
      }),
    ).toThrow(/both available and deprecated/);
  });

  it('rejects editOwnPostsOnly without edit support', () => {
    expect(() =>
      defineCapabilities({
        ...base,
        lifecycle: { edit: false, editOwnPostsOnly: true, delete: true, readStatus: true },
      }),
    ).toThrow(/editOwnPostsOnly/);
  });
});
