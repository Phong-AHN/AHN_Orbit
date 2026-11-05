/**
 * Facets: where the links and hashtags are in a Bluesky post.
 *
 * Bluesky does not find them itself. A URL in the text is plain text unless
 * the record carries a facet saying "bytes 12 to 40 are a link to …", and the
 * offsets are **UTF-8 bytes**, not characters. That matters here more than
 * almost anywhere: a Vietnamese letter with its marks is two or three bytes,
 * so offsets counted in characters land in the middle of the wrong word.
 *
 * Mentions are deliberately absent — a mention facet names a DID, and handles
 * are not resolved (see `mentions: false` in the capabilities).
 */

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<
    | { $type: 'app.bsky.richtext.facet#link'; uri: string }
    | { $type: 'app.bsky.richtext.facet#tag'; tag: string }
  >;
}

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;
/** Punctuation that ends a sentence rather than a URL. */
const TRAILING = /[.,;:!?'")\]}]+$/;
/** A hashtag: after the start or whitespace, not all digits, no spaces. */
const TAG_PATTERN = /(^|\s)[#＃]([^\s#＃]+)/gu;

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

export function detectFacets(text: string): Facet[] {
  const facets: Facet[] = [];

  for (const match of text.matchAll(URL_PATTERN)) {
    const uri = match[0].replace(TRAILING, '');
    const start = match.index ?? 0;
    facets.push({
      index: {
        byteStart: bytes(text.slice(0, start)),
        byteEnd: bytes(text.slice(0, start + uri.length)),
      },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }

  for (const match of text.matchAll(TAG_PATTERN)) {
    const tag = (match[2] ?? '').replace(TRAILING, '');
    // "#1" is a number, not a tag; Bluesky ignores all-digit tags too. And
    // the lexicon caps a tag at 64 graphemes.
    if (!tag || /^\d+$/.test(tag) || [...tag].length > 64) continue;

    const hashAt = (match.index ?? 0) + (match[1]?.length ?? 0);
    facets.push({
      index: {
        byteStart: bytes(text.slice(0, hashAt)),
        byteEnd: bytes(text.slice(0, hashAt + 1 + tag.length)),
      },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
    });
  }

  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}
