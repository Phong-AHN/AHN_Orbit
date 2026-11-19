import { describe, expect, it } from 'vitest';
import { defineCapabilities } from './capabilities.js';
import {
  assignThreadMedia,
  joinManualThread,
  readThreadMedia,
  readThreadProgress,
  resolveThreadDraft,
  splitIntoThread,
  splitIntoThreadCount,
  splitManualThread,
  threadCountRange,
  stripThreadBreaks,
  threadFingerprint,
  threadNumbered,
  threadRequested,
  withoutThreadMarker,
} from './thread.js';
import { countCharacters, threadPartsFor, validateDraft, weightedLength } from './validation.js';
import { xCapabilities } from './x/capabilities.js';
import { blueskyCapabilities } from './bluesky/capabilities.js';
import { threadsCapabilities } from './threads/capabilities.js';
import { facebookPageCapabilities } from './facebook/capabilities.js';

/**
 * Splitting a long caption into a thread (D-124).
 *
 * The property that matters above all: every part fits, counted the way the
 * platform counts. A part one character over is refused by the platform with
 * the earlier parts already live.
 */

const x = xCapabilities('2');
const bluesky = blueskyCapabilities('1');
const threads = threadsCapabilities('v1.0', { threadReplies: true });

const plain = (text: string) => [...text].length;

function sentence(n: number): string {
  return `Sentence number ${n} says something useful about the product.`;
}

describe('splitIntoThread', () => {
  it('returns text that fits as it is, unnumbered', () => {
    expect(splitIntoThread('  Short and sweet.  ', 280, plain)).toEqual(['Short and sweet.']);
  });

  it('numbers every part and keeps each within the limit, marker included', () => {
    const text = Array.from({ length: 20 }, (_, i) => sentence(i + 1)).join(' ');
    const parts = splitIntoThread(text, 280, plain);

    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((part, index) => {
      expect(plain(part)).toBeLessThanOrEqual(280);
      expect(part.endsWith(` ${index + 1}/${parts.length}`)).toBe(true);
    });
  });

  it('loses no word and invents none', () => {
    const text = Array.from({ length: 30 }, (_, i) => sentence(i + 1)).join(' ');
    const parts = splitIntoThread(text, 200, plain);
    const rejoined = parts.map((part) => part.replace(/ \d+\/\d+$/, '')).join(' ');
    expect(rejoined.split(/\s+/)).toEqual(text.split(/\s+/));
  });

  it('breaks at a paragraph when one is in reach', () => {
    const first = 'A'.repeat(10) + ' ' + Array.from({ length: 8 }, (_, i) => `word${i}`).join(' ');
    const second = Array.from({ length: 40 }, (_, i) => `more${i}`).join(' ');
    const parts = splitIntoThread(`${first}\n\n${second}`, 120, plain);

    expect(parts[0]).toBe(`${first} 1/${parts.length}`);
  });

  it('prefers the end of a sentence to a bare space', () => {
    const text = `${'Lorem ipsum dolor sit amet. '.repeat(3)}consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore`;
    const [first] = splitIntoThread(text, 100, plain);
    expect(first?.replace(/ \d+\/\d+$/, '').endsWith('.')).toBe(true);
  });

  it('ends every post on a whole sentence while one is in reach', () => {
    const sentences = [
      'Hôm nay chúng tôi ra mắt sản phẩm mới.',
      'Nó giúp đội ngũ làm việc nhanh hơn!',
      'Bạn đã thử chưa?',
      'Đặt hàng ngay hôm nay, giao trong hai ngày.',
      'Liên hệ chúng tôi để biết thêm chi tiết…',
    ];
    const text = Array.from({ length: 6 }, () => sentences.join(' ')).join(' ');
    const parts = splitIntoThread(text, 120, plain);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(plain(part)).toBeLessThanOrEqual(120);
      expect(part.replace(/ \d+\/\d+$/, '')).toMatch(/[.!?…]$/);
    }
  });

  it('does not treat a colon or a semicolon as the end of a sentence', () => {
    // Within reach: "One." and, wrongly, "three:" and "eleven;". Only the first ends a sentence.
    const text =
      'One. Two three: four five six seven eight nine ten eleven; twelve thirteen fourteen fifteen sixteen seventeen.';
    const [first] = splitIntoThread(text, 70, plain);
    expect(first).toMatch(/^One\. 1\/\d+$/);
  });

  it('cuts at a space only when one sentence is longer than a whole post', () => {
    const long = `${'word '.repeat(60).trim()}.`;
    const parts = splitIntoThread(long, 100, plain);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(plain(part)).toBeLessThanOrEqual(100);
    expect(
      parts
        .at(-1)
        ?.replace(/ \d+\/\d+$/, '')
        .endsWith('.'),
    ).toBe(true);
  });

  it('keeps the line breaks inside a part as written', () => {
    const text = `Line one\nline two. ${'Short sentence here. '.repeat(10).trim()}`;
    const [first] = splitIntoThread(text, 120, plain);
    expect(first?.startsWith('Line one\nline two. Short sentence here.')).toBe(true);
  });

  it('cuts a run with no space in it, after a full stop where it can', () => {
    const sentenceZh = '这是一个关于产品的有用句子。';
    const text = sentenceZh.repeat(20);
    const parts = splitIntoThread(text, 100, plain);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(plain(part)).toBeLessThanOrEqual(100);
    expect(parts[0]?.replace(/ \d+\/\d+$/, '').endsWith('。')).toBe(true);
  });

  it('widens the marker when the thread reaches ten parts', () => {
    const text = Array.from({ length: 60 }, (_, i) => sentence(i + 1)).join(' ');
    const parts = splitIntoThread(text, 120, plain);

    expect(parts.length).toBeGreaterThanOrEqual(10);
    for (const part of parts) expect(plain(part)).toBeLessThanOrEqual(120);
    expect(parts.at(-1)?.endsWith(` ${parts.length}/${parts.length}`)).toBe(true);
  });
});

describe('threadPartsFor', () => {
  it('counts Vietnamese the way X does, so no part is refused', () => {
    const body = Array.from(
      { length: 12 },
      () => 'Chúng tôi rất vui được giới thiệu sản phẩm mới với nhiều tính năng hữu ích.',
    ).join(' ');
    const parts = threadPartsFor({ body, thread: true }, x);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(weightedLength(part)).toBeLessThanOrEqual(280);
  });

  it('bills a link at X’s fixed cost rather than its length', () => {
    const link = `https://example.com/${'a'.repeat(200)}`;
    const body = `${'Read this. '.repeat(20)}${link}`;
    const parts = threadPartsFor({ body, thread: true }, x);

    for (const part of parts) expect(countCharacters(part, x)).toBeLessThanOrEqual(280);
    expect(parts.some((part) => part.includes(link))).toBe(true);
  });

  it('closes the thread with the hashtags and the link, once', () => {
    const body = 'Long text. '.repeat(40).trim();
    const parts = threadPartsFor(
      { body, hashtags: ['launch', '#news'], linkUrl: 'https://example.com/p', thread: true },
      bluesky,
    );

    const last = parts.at(-1) ?? '';
    expect(last).toContain('#launch #news');
    expect(last).toContain('https://example.com/p');
    expect(parts.slice(0, -1).some((part) => part.includes('#launch'))).toBe(false);
  });

  it('leaves the link out of the text where the platform sends it as a card', () => {
    const body = 'Long text. '.repeat(80).trim();
    const parts = threadPartsFor({ body, linkUrl: 'https://example.com/p', thread: true }, threads);
    expect(parts.some((part) => part.includes('https://example.com/p'))).toBe(false);
  });

  it('is one post when threads are off, however long', () => {
    const body = 'Long text. '.repeat(80).trim();
    expect(threadPartsFor({ body }, x)).toHaveLength(1);
    expect(threadPartsFor({ body, thread: true }, facebookPageCapabilities('v25.0'))).toHaveLength(
      1,
    );
  });
});

describe('numbering (1/3, 2/3…)', () => {
  const text = Array.from({ length: 20 }, (_, i) => sentence(i + 1)).join(' ');

  it('is on by default, and off only when switched off', () => {
    expect(threadNumbered(undefined)).toBe(true);
    expect(threadNumbered({})).toBe(true);
    expect(threadNumbered({ threadNumbering: true })).toBe(true);
    expect(threadNumbered({ threadNumbering: false })).toBe(false);
  });

  it('leaves the marker off when numbering is off, and uses the whole limit', () => {
    const numbered = splitIntoThread(text, 280, plain);
    const bare = splitIntoThread(text, 280, plain, { numbered: false });

    expect(bare.length).toBeGreaterThan(1);
    for (const part of bare) {
      expect(part).not.toMatch(/ \d+\/\d+$/);
      expect(plain(part)).toBeLessThanOrEqual(280);
      expect(part).toMatch(/[.!?…]$/);
    }
    // Nothing is lost or added: the same words, in the same order.
    expect(bare.join(' ').split(/\s+/)).toEqual(text.split(/\s+/));
    expect(bare.length).toBeLessThanOrEqual(numbered.length);
  });

  it('follows the draft, so the validator and the adapter split alike', () => {
    const on = threadPartsFor({ body: text, thread: true }, x);
    const off = threadPartsFor({ body: text, thread: true, threadNumbering: false }, x);

    expect(on.every((part, index) => part.endsWith(` ${index + 1}/${on.length}`))).toBe(true);
    expect(off.some((part) => / \d+\/\d+$/.test(part))).toBe(false);
    expect(validateDraft(x, { body: text, thread: true, threadNumbering: false }).valid).toBe(true);
  });
});

describe('a thread edited by hand', () => {
  const posts = ['First post, written by hand.', 'Second post.', 'Third and last.'];
  const body = joinManualThread(posts);

  it('stores the posts with --- lines and reads them back, empties dropped', () => {
    expect(body).toBe(
      'First post, written by hand.\n\n---\n\nSecond post.\n\n---\n\nThird and last.',
    );
    expect(splitManualThread(body)).toEqual(posts);
    expect(splitManualThread('---\nOne\n  ---  \n\n---\nTwo\n---')).toEqual(['One', 'Two']);
    expect(joinManualThread(['A', '  ', 'B'])).toBe('A\n\n---\n\nB');
  });

  it('publishes each post as written, with its place', () => {
    const parts = threadPartsFor({ body, thread: true, threadManual: true }, x);
    expect(parts).toEqual([
      'First post, written by hand. 1/3',
      'Second post. 2/3',
      'Third and last. 3/3',
    ]);
  });

  it('leaves the place off when numbering is off', () => {
    const parts = threadPartsFor(
      { body, thread: true, threadManual: true, threadNumbering: false },
      x,
    );
    expect(parts).toEqual(posts);
  });

  it('adds only the hashtags and link not already written into a post', () => {
    const written = joinManualThread(['Intro.', 'Details #launch']);
    const parts = threadPartsFor(
      {
        body: written,
        thread: true,
        threadManual: true,
        threadNumbering: false,
        hashtags: ['launch', 'news'],
        linkUrl: 'https://example.com/p',
      },
      bluesky,
    );
    expect(parts).toEqual(['Intro.', 'Details #launch\n\n#news\n\nhttps://example.com/p']);
  });

  it('refuses a post made too long by hand rather than splitting it again', () => {
    const tooLong = joinManualThread(['Fine.', 'x'.repeat(400)]);
    const result = validateDraft(x, { body: tooLong, thread: true, threadManual: true });
    const issue = result.issues.find((i) => i.code === 'TEXT_TOO_LONG');

    expect(result.valid).toBe(false);
    expect(issue?.meta).toMatchObject({ part: 2 });
  });

  it('decides the draft once, for the validator and the worker alike', () => {
    expect(
      resolveThreadDraft({
        body,
        hasOwnText: true,
        platformOptions: { threadManual: true },
        capabilities: x,
      }),
    ).toEqual({ body, thread: true, threadManual: true });

    // Inherited text was never written post by post.
    expect(
      resolveThreadDraft({
        body: 'Main text.',
        hasOwnText: false,
        platformOptions: { threadManual: true },
        capabilities: x,
      }),
    ).toEqual({ body: 'Main text.', thread: true });

    // Splitting switched off: one post, and no --- left in it.
    expect(
      resolveThreadDraft({
        body,
        hasOwnText: true,
        platformOptions: { thread: false, threadManual: true },
        capabilities: x,
      }),
    ).toEqual({ body: stripThreadBreaks(body) });
    expect(stripThreadBreaks(body)).toBe(posts.join('\n\n'));
  });

  it('shows a split post without its place, ready to edit', () => {
    expect(withoutThreadMarker('Some words. 2/5')).toBe('Some words.');
    expect(withoutThreadMarker('No marker here')).toBe('No marker here');
  });
});

describe('attachments across a thread', () => {
  const xLimits = { maxAttachments: 4, soloKinds: ['VIDEO', 'GIF'] };
  const img = (id: string) => ({ id, kind: 'IMAGE' });
  const vid = (id: string) => ({ id, kind: 'VIDEO' });
  const ids = (groups: Array<Array<{ id: string }>>) => groups.map((g) => g.map((m) => m.id));

  it('keeps every attachment on the first post while it fits', () => {
    expect(ids(assignThreadMedia([img('a'), img('b')], 3, undefined, xLimits))).toEqual([
      ['a', 'b'],
      [],
      [],
    ]);
  });

  it('moves what does not fit on to the next posts, in order', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(img);
    expect(ids(assignThreadMedia(six, 3, undefined, xLimits))).toEqual([
      ['a', 'b', 'c', 'd'],
      ['e', 'f'],
      [],
    ]);
  });

  it('gives a video a post of its own where the platform says it must be alone', () => {
    expect(ids(assignThreadMedia([img('a'), vid('v'), img('b')], 3, undefined, xLimits))).toEqual([
      ['a'],
      ['v'],
      ['b'],
    ]);
  });

  it('keeps an attachment where somebody put it, on the last post if the thread shrank', () => {
    const placed = assignThreadMedia([img('a'), img('b'), img('c')], 2, { b: 1, c: 7 }, xLimits);
    expect(ids(placed)).toEqual([['a'], ['b', 'c']]);
  });

  it('puts what cannot fit anywhere on the last post, for the validator to name', () => {
    const nine = Array.from({ length: 9 }, (_, i) => img(`m${i}`));
    expect(assignThreadMedia(nine, 2, undefined, xLimits).map((g) => g.length)).toEqual([4, 5]);
  });

  it('reads a stored placement, dropping anything that is not a post index', () => {
    expect(readThreadMedia({ a: 1, b: -1, c: 1.5, d: '2', e: 0 })).toEqual({ a: 1, e: 0 });
    expect(readThreadMedia(['a'])).toBeUndefined();
    expect(readThreadMedia(null)).toBeUndefined();
  });

  const long = Array.from({ length: 14 }, (_, i) => sentence(i + 1)).join(' ');
  const image = (id: string) => ({
    id,
    kind: 'IMAGE' as const,
    mimeType: 'image/jpeg',
    sizeBytes: 200_000,
    width: 1200,
    height: 800,
  });
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(image);

  it('accepts more images than one post allows once they spread over a thread', () => {
    expect(validateDraft(x, { body: long, media: six }).issues.map((i) => i.code)).toContain(
      'TOO_MANY_ATTACHMENTS',
    );
    expect(
      validateDraft(x, { body: long, media: six, thread: true }).issues.map((i) => i.code),
    ).not.toContain('TOO_MANY_ATTACHMENTS');
  });

  it('names the post somebody overloaded by hand', () => {
    const result = validateDraft(x, {
      body: long,
      media: six,
      thread: true,
      threadMedia: { a: 1, b: 1, c: 1, d: 1, e: 1 },
    });
    const issue = result.issues.find((i) => i.code === 'TOO_MANY_ATTACHMENTS');
    expect(issue?.meta).toMatchObject({ part: 2, count: 5 });
    expect(issue?.message).toMatch(/^Post 2 of the thread:/);
  });

  it('carries the placement through the draft only while splitting is on', () => {
    expect(
      resolveThreadDraft({
        body: 'x',
        hasOwnText: false,
        platformOptions: { threadMedia: { a: 1 } },
        capabilities: x,
      }).threadMedia,
    ).toEqual({ a: 1 });
    expect(
      resolveThreadDraft({
        body: 'x',
        hasOwnText: false,
        platformOptions: { thread: false, threadMedia: { a: 1 } },
        capabilities: x,
      }).threadMedia,
    ).toBeUndefined();
  });
});

describe('a chosen number of posts', () => {
  // Twelve sentences of 60 characters: at 200 a post, three fit with a marker.
  const twelve = Array.from(
    { length: 12 },
    (_, i) => `Sentence ${String(i + 1).padStart(2, '0')} carries exactly enough words to matter.`,
  ).join(' ');

  it('says how many posts the text can be, every post ending at a sentence', () => {
    const range = threadCountRange(twelve, 200, plain, { maxPosts: 10 });
    expect(range).not.toBeNull();
    // The automatic split is already the fewest at sentence ends.
    expect(range!.min).toBe(range!.auto);
    expect(range!.max).toBe(10);
  });

  it('offers nothing for text that fits in one post', () => {
    expect(threadCountRange('Short.', 200, plain, { maxPosts: 10 })).toBeNull();
  });

  it('splits into exactly the count asked for, evenly, at sentence ends when it can', () => {
    const range = threadCountRange(twelve, 200, plain, { maxPosts: 10 })!;
    const count = range.min + 1;
    const parts = splitIntoThreadCount(twelve, 200, plain, count)!;

    expect(parts).toHaveLength(count);
    for (const part of parts) {
      expect(plain(part)).toBeLessThanOrEqual(200);
      expect(part.replace(/ \d+\/\d+$/, '')).toMatch(/\.$/);
    }
    // Even: the longest post is within one sentence (~60) of the average.
    const lengths = parts.map(plain);
    const average = lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
    expect(Math.max(...lengths)).toBeLessThanOrEqual(average + 62);
  });

  /** The owner, 2026-11-19: a chosen count never cuts a sentence. */
  it('never offers, nor splits into, fewer posts than sentence ends allow', () => {
    // Three long sentences of ~150: two posts would mean cutting one.
    const three = Array.from(
      { length: 3 },
      (_, i) => `Opening ${i} ${'word '.repeat(28).trim()}.`,
    ).join(' ');
    const range = threadCountRange(three, 260, plain, { maxPosts: 10 })!;
    expect(range.min).toBe(3);
    expect(splitIntoThreadCount(three, 260, plain, 2)).toBeNull();

    const parts = splitIntoThreadCount(three, 260, plain, 3)!;
    for (const part of parts) expect(part.replace(/ \d+\/\d+$/, '')).toMatch(/\.$/);
  });

  it('offers no count where a sentence is longer than a whole post', () => {
    const endless = `${'word '.repeat(120).trim()}.`;
    expect(threadCountRange(endless, 200, plain, { maxPosts: 10 })).toBeNull();
  });

  it('refuses a count the text cannot be', () => {
    expect(splitIntoThreadCount(twelve, 200, plain, 2)).toBeNull();
    expect(splitIntoThreadCount(twelve, 200, plain, 1)).toBeNull();
  });

  it('publishes the chosen count, and refuses one the text can no longer be', () => {
    const body = Array.from({ length: 14 }, (_, i) => sentence(i + 1)).join(' ');
    const auto = threadPartsFor({ body, thread: true }, x).length;

    const more = threadPartsFor({ body, thread: true, threadPosts: auto + 1 }, x);
    expect(more).toHaveLength(auto + 1);
    expect(validateDraft(x, { body, thread: true, threadPosts: auto + 1 }).valid).toBe(true);

    const result = validateDraft(x, { body, thread: true, threadPosts: 2 });
    const issue = result.issues.find((i) => i.code === 'THREAD_COUNT_UNREACHABLE');
    expect(result.valid).toBe(false);
    expect(issue?.message).toMatch(/cannot be 2 posts here with every post ending at a sentence/);
    // The preview still shows a split: the automatic one.
    expect(threadPartsFor({ body, thread: true, threadPosts: 2 }, x)).toHaveLength(auto);
  });

  it('applies a count to the automatic split only, never to posts edited by hand', () => {
    expect(
      resolveThreadDraft({
        body: 'x',
        hasOwnText: false,
        platformOptions: { threadPosts: 4 },
        capabilities: x,
      }).threadPosts,
    ).toBe(4);
    expect(
      resolveThreadDraft({
        body: joinManualThread(['A.', 'B.']),
        hasOwnText: true,
        platformOptions: { threadPosts: 4, threadManual: true },
        capabilities: x,
      }).threadPosts,
    ).toBeUndefined();
    expect(
      resolveThreadDraft({
        body: 'x',
        hasOwnText: false,
        platformOptions: { threadPosts: null },
        capabilities: x,
      }).threadPosts,
    ).toBeUndefined();
  });
});

describe('threadRequested', () => {
  it('is on by default where the platform can thread, and off only when switched off', () => {
    expect(threadRequested(undefined, x)).toBe(true);
    expect(threadRequested({}, x)).toBe(true);
    expect(threadRequested({ thread: true }, bluesky)).toBe(true);
    expect(threadRequested({ thread: false }, x)).toBe(false);
  });

  it('is never on where the platform cannot thread, so the default raises no error there', () => {
    expect(threadRequested(undefined, facebookPageCapabilities('v25.0'))).toBe(false);
    expect(threadRequested({ thread: true }, threadsCapabilities('v1.0'))).toBe(false);
  });
});

describe('validateDraft in a thread', () => {
  const long = Array.from({ length: 14 }, (_, i) => sentence(i + 1)).join(' ');

  it('refuses the long text as one post, and accepts it as a thread', () => {
    expect(validateDraft(x, { body: long }).issues.map((i) => i.code)).toContain('TEXT_TOO_LONG');

    const threaded = validateDraft(x, { body: long, thread: true });
    expect(threaded.valid).toBe(true);
    expect(threaded.issues.map((i) => i.code)).not.toContain('TEXT_NEAR_LIMIT');
  });

  it('refuses a thread longer than the platform’s most', () => {
    const tooLong = Array.from({ length: 80 }, (_, i) => sentence(i + 1)).join(' ');
    const result = validateDraft(x, { body: tooLong, thread: true });
    const issue = result.issues.find((i) => i.code === 'THREAD_TOO_LONG');

    expect(result.valid).toBe(false);
    expect(issue?.meta).toMatchObject({ maxPosts: 10 });
  });

  it('refuses a thread on a platform that cannot publish one', () => {
    const result = validateDraft(facebookPageCapabilities('v25.0'), {
      body: 'Hello',
      thread: true,
    });
    expect(result.issues.map((i) => i.code)).toContain('THREAD_UNSUPPORTED');
  });

  it('refuses a thread on Threads until threads are switched on', () => {
    const off = threadsCapabilities('v1.0');
    expect(validateDraft(off, { body: long, thread: true }).issues.map((i) => i.code)).toContain(
      'THREAD_UNSUPPORTED',
    );
  });

  it('counts links post by post, so two links in two posts pass a one-link limit', () => {
    const half = 'Words here. '.repeat(30).trim();
    const body = `${half} https://a.example/one\n\n${half} https://b.example/two`;

    expect(validateDraft(threads, { body }).issues.map((i) => i.code)).toContain('TOO_MANY_LINKS');
    expect(validateDraft(threads, { body, thread: true }).issues.map((i) => i.code)).not.toContain(
      'TOO_MANY_LINKS',
    );
  });

  it('counts the link card against the first post only', () => {
    const body = `https://a.example/one ${'Words here. '.repeat(60).trim()}`;
    const result = validateDraft(threads, {
      body,
      linkUrl: 'https://card.example',
      thread: true,
    });
    const issue = result.issues.find((i) => i.code === 'TOO_MANY_LINKS');
    expect(issue?.meta).toMatchObject({ part: 1 });
  });
});

describe('progress', () => {
  it('fingerprints the parts, not the draft they came from', () => {
    expect(threadFingerprint(['a', 'b'])).toBe(threadFingerprint(['a', 'b']));
    expect(threadFingerprint(['a', 'b'])).not.toBe(threadFingerprint(['a', 'c']));
    expect(threadFingerprint(['ab'])).not.toBe(threadFingerprint(['a', 'b']));
  });

  it('continues a thread recorded for the same parts', () => {
    const fingerprint = threadFingerprint(['a', 'b']);
    const progress = readThreadProgress(
      { thread: { fingerprint, total: 2, posted: [{ id: 'p1' }] } },
      fingerprint,
    );
    expect(progress).toEqual({ fingerprint, total: 2, posted: [{ id: 'p1' }] });
  });

  it('flags a live thread whose text has changed, and ignores one that never started', () => {
    const recorded = { fingerprint: 'old', total: 2, posted: [{ id: 'p1' }] };
    expect(readThreadProgress({ thread: recorded }, 'new')).toBe('CHANGED');
    expect(readThreadProgress({ thread: { ...recorded, posted: [] } }, 'new')).toBeUndefined();
  });

  it('ignores a malformed record rather than trusting it', () => {
    expect(readThreadProgress({ thread: { fingerprint: 'f', total: 2, posted: [{}] } }, 'f')).toBe(
      undefined,
    );
    expect(readThreadProgress({ thread: 'nonsense' }, 'f')).toBeUndefined();
    expect(readThreadProgress(undefined, 'f')).toBeUndefined();
  });
});

describe('the descriptor', () => {
  it('refuses a thread claim with no ceiling', () => {
    const base = xCapabilities('2');
    expect(() => defineCapabilities({ ...base, thread: { supported: true } })).toThrow(/maxPosts/);
  });
});
