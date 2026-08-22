import { describe, expect, it } from 'vitest';
import {
  joinList,
  missingPlatformSettings,
  requiresPlatformSettings,
  summariseMissingSettings,
} from './platform-settings';

/**
 * What the composer tells somebody a post still needs.
 *
 * The cases worth having are the ones that decide whether a warning appears at
 * all: a `false` that is a real answer, a TikTok mode where the question does
 * not apply, and a Pinterest rule that depends on what is attached rather than
 * on what was chosen.
 *
 * None of this can *permit* a publish — the adapter refuses server-side
 * regardless — so every test here is about whether the right thing is said, not
 * about whether the post is valid.
 */

const noMedia: ReadonlyArray<{ kind: string }> = [];

describe('requiresPlatformSettings', () => {
  it('names the three platforms that make a post carry a choice', () => {
    expect(requiresPlatformSettings('TIKTOK')).toBe(true);
    expect(requiresPlatformSettings('YOUTUBE')).toBe(true);
    expect(requiresPlatformSettings('PINTEREST')).toBe(true);
  });

  /** A card for a platform that asks nothing would be a card about nothing. */
  it('leaves the feed platforms alone', () => {
    expect(requiresPlatformSettings('FACEBOOK')).toBe(false);
    expect(requiresPlatformSettings('INSTAGRAM')).toBe(false);
    expect(requiresPlatformSettings('LINKEDIN')).toBe(false);
    expect(requiresPlatformSettings('THREADS')).toBe(false);
  });
});

describe('YouTube', () => {
  it('asks for the declaration when nothing has been answered', () => {
    const missing = missingPlatformSettings({
      platform: 'YOUTUBE',
      options: {},
      media: noMedia,
    });

    expect(missing.map((m) => m.id)).toEqual(['madeForKids']);
  });

  /**
   * **`false` is a complete answer, not a missing one.**
   *
   * A falsiness check here would nag forever at everybody who answered "no,
   * not made for kids" — which is the answer almost every post gives.
   */
  it('treats "no, not made for kids" as answered', () => {
    expect(
      missingPlatformSettings({
        platform: 'YOUTUBE',
        options: { madeForKids: false },
        media: noMedia,
      }),
    ).toEqual([]);
  });

  it('treats "yes" as answered too', () => {
    expect(
      missingPlatformSettings({
        platform: 'YOUTUBE',
        options: { madeForKids: true },
        media: noMedia,
      }),
    ).toEqual([]);
  });

  /** Privacy has a safe default (private); the declaration deliberately has none. */
  it('does not ask for a privacy setting, which defaults safely', () => {
    const missing = missingPlatformSettings({
      platform: 'YOUTUBE',
      options: { madeForKids: false },
      media: noMedia,
    });

    expect(missing.map((m) => m.id)).not.toContain('privacyStatus');
  });
});

describe('TikTok', () => {
  it('asks who can see a direct post', () => {
    const missing = missingPlatformSettings({
      platform: 'TIKTOK',
      options: { postMode: 'DIRECT_POST' },
      media: noMedia,
    });

    expect(missing.map((m) => m.id)).toEqual(['privacyLevel']);
  });

  /**
   * Upload mode sends no visibility at all — the creator picks it in TikTok's
   * own editor. Asking for one would be asking for something never sent.
   */
  it('asks nothing in upload mode, where visibility is not ours to set', () => {
    expect(
      missingPlatformSettings({
        platform: 'TIKTOK',
        options: { postMode: 'MEDIA_UPLOAD' },
        media: noMedia,
      }),
    ).toEqual([]);
  });

  it('is satisfied once a visibility is chosen', () => {
    expect(
      missingPlatformSettings({
        platform: 'TIKTOK',
        options: { privacyLevel: 'SELF_ONLY' },
        media: noMedia,
      }),
    ).toEqual([]);
  });
});

describe('Pinterest', () => {
  it('asks for a board, which Pinterest has no default for', () => {
    const missing = missingPlatformSettings({
      platform: 'PINTEREST',
      options: {},
      media: noMedia,
    });

    expect(missing.map((m) => m.id)).toEqual(['boardId']);
  });

  /** An empty string is not a board id, and the server would reject it. */
  it('does not accept an empty board id as a choice', () => {
    const missing = missingPlatformSettings({
      platform: 'PINTEREST',
      options: { boardId: '' },
      media: noMedia,
    });

    expect(missing.map((m) => m.id)).toEqual(['boardId']);
  });

  /**
   * The cover rule depends on what is attached, not on what was chosen —
   * which is why the media list is passed in rather than inferred.
   */
  it('asks for a cover image once a video is attached with no image', () => {
    const missing = missingPlatformSettings({
      platform: 'PINTEREST',
      options: { boardId: 'board-1' },
      media: [{ kind: 'VIDEO' }],
    });

    expect(missing.map((m) => m.id)).toEqual(['coverImage']);
  });

  it('is satisfied when an image is attached alongside the video', () => {
    expect(
      missingPlatformSettings({
        platform: 'PINTEREST',
        options: { boardId: 'board-1' },
        media: [{ kind: 'VIDEO' }, { kind: 'IMAGE' }],
      }),
    ).toEqual([]);
  });

  /**
   * A post with nothing attached yet is not wrong, it is unfinished. Warning
   * about a cover for a video nobody has added is noise that trains people to
   * ignore the panel.
   */
  it('says nothing about a cover when there is no video', () => {
    expect(
      missingPlatformSettings({
        platform: 'PINTEREST',
        options: { boardId: 'board-1' },
        media: noMedia,
      }),
    ).toEqual([]);
  });

  it('counts a GIF as a usable cover, since Pinterest pins it as an image', () => {
    expect(
      missingPlatformSettings({
        platform: 'PINTEREST',
        options: { boardId: 'board-1' },
        media: [{ kind: 'VIDEO' }, { kind: 'GIF' }],
      }),
    ).toEqual([]);
  });
});

describe('summariseMissingSettings', () => {
  /**
   * Null rather than "0 accounts need attention" — a sentence that makes
   * somebody look for a problem that is not there.
   */
  it('says nothing when nothing is outstanding', () => {
    expect(
      summariseMissingSettings([
        { platform: 'YOUTUBE', accountName: 'Client Channel', missing: [] },
      ]),
    ).toBeNull();
  });

  /** One account: name it and say exactly what it wants. */
  it('names the account and the setting when only one is unfinished', () => {
    const summary = summariseMissingSettings([
      {
        platform: 'YOUTUBE',
        accountName: 'Client Channel',
        missing: [{ id: 'madeForKids', label: 'whether it is made for children' }],
      },
      { platform: 'PINTEREST', accountName: 'Client Pins', missing: [] },
    ]);

    expect(summary).toBe('Client Channel still needs whether it is made for children.');
  });

  it('counts them when several are unfinished', () => {
    const summary = summariseMissingSettings([
      {
        platform: 'YOUTUBE',
        accountName: 'Client Channel',
        missing: [{ id: 'madeForKids', label: 'whether it is made for children' }],
      },
      {
        platform: 'PINTEREST',
        accountName: 'Client Pins',
        missing: [{ id: 'boardId', label: 'which board to pin it to' }],
      },
    ]);

    expect(summary).toBe('2 accounts still need settings before this post can publish.');
  });
});

describe('joinList', () => {
  it('reads as a sentence rather than a comma-separated field list', () => {
    expect(joinList(['a'])).toBe('a');
    expect(joinList(['a', 'b'])).toBe('a and b');
    expect(joinList(['a', 'b', 'c'])).toBe('a, b and c');
    expect(joinList([])).toBe('');
  });
});
