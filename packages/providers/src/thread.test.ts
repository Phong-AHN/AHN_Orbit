import { describe, expect, it } from 'vitest';
import { defineCapabilities } from './capabilities.js';
import {
  readThreadProgress,
  splitIntoThread,
  threadFingerprint,
  threadRequested,
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
