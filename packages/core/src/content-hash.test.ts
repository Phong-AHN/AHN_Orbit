import { describe, expect, it } from 'vitest';
import { contentHash, matchesPublishedText, normaliseForHash } from './content-hash.js';

describe('contentHash', () => {
  it('is stable for identical content', () => {
    const c = { body: 'Launch day is here.', linkUrl: 'https://example.com' };
    expect(contentHash(c)).toBe(contentHash({ ...c }));
  });

  it('ignores whitespace and line-ending differences a platform may introduce', () => {
    expect(contentHash({ body: 'Hello  world\r\nSecond line' })).toBe(
      contentHash({ body: 'Hello world\nSecond line' }),
    );
  });

  it('normalises Unicode form so composed and decomposed text agree', () => {
    expect(contentHash({ body: 'café' })).toBe(contentHash({ body: 'café' }));
  });

  it('changes when the body, link, or media change', () => {
    const base = { body: 'A', linkUrl: 'https://a.test', mediaKeys: ['m1'] };
    expect(contentHash({ ...base, body: 'B' })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, linkUrl: 'https://b.test' })).not.toBe(contentHash(base));
    expect(contentHash({ ...base, mediaKeys: ['m2'] })).not.toBe(contentHash(base));
  });

  it('treats media order as meaningful — a carousel is a sequence', () => {
    expect(contentHash({ body: 'x', mediaKeys: ['a', 'b'] })).not.toBe(
      contentHash({ body: 'x', mediaKeys: ['b', 'a'] }),
    );
  });

  it('treats a missing link and an empty link as the same', () => {
    expect(contentHash({ body: 'x' })).toBe(contentHash({ body: 'x', linkUrl: null }));
  });
});

describe('normaliseForHash', () => {
  it('collapses runs of spaces and trims surrounding whitespace', () => {
    expect(normaliseForHash('  a   b  \n  c  ')).toBe('a b\nc');
  });
});

describe('matchesPublishedText', () => {
  const body =
    'Our new studio opens on Thursday and we would love to see you there for the launch party.';

  it('matches text the platform reflowed', () => {
    expect(matchesPublishedText(body.replace(/ /g, '  '), body)).toBe(true);
  });

  it('matches a truncated caption returned in a list response', () => {
    expect(matchesPublishedText(body.slice(0, 60), body)).toBe(true);
  });

  it('does not match two posts that merely share a short opening', () => {
    expect(matchesPublishedText('Our new', body)).toBe(false);
  });

  it('does not match unrelated content', () => {
    expect(matchesPublishedText('A completely different announcement entirely here', body)).toBe(
      false,
    );
  });

  it('does not match empty text', () => {
    expect(matchesPublishedText('', body)).toBe(false);
  });
});
