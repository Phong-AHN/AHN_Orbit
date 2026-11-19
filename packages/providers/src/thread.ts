/**
 * Splitting text too long for one post into a thread (**D-124**).
 *
 * Pure and platform-blind. The caller passes the platform's own way of
 * counting — X's weighted characters, Bluesky's graphemes, a link billed at a
 * fixed cost — so the parts this produces are the parts the validator checks,
 * the composer shows and the adapter publishes. One function, so the three
 * cannot disagree about where a thread breaks.
 *
 * ## Where it breaks
 *
 * **Only where a sentence ends** — after `.`, `!`, `?`, `…` (or `。！？`), or
 * at a line or paragraph break — and as late as the limit allows, so each post
 * carries as many whole sentences as fit. A post never ends mid-sentence
 * unless a single sentence is longer than a whole post; only then is it cut at
 * the last space that fits. A run with no space in it (a long link, Chinese or
 * Japanese text) is cut inside, after a full stop where there is one.
 *
 * Every part of a thread ends with its place, " 2/5", counted against the
 * limit like any other text — unless numbering is switched off for the
 * account, when the parts carry the text alone and use the whole limit. Text
 * that fits in one post is returned as it is, unnumbered either way.
 */

/** Counts text the way the platform does. */
export type Measure = (text: string) => number;

/** Never let a numbered part be shorter than this, whatever the limit. */
const MIN_BUDGET = 10;

/**
 * A word that ends a sentence, closing quotes and brackets allowed after the
 * stop. Not `:` or `;` — the sentence goes on after those.
 */
const SENTENCE_END = /[.!?…。！？]["'”’)\]]*$/u;
const CJK_STOP = /[。！？]/u;

const graphemeSegmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : undefined;

function graphemesOf(text: string): string[] {
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
    : [...text];
}

/**
 * Whether a variant is split into a thread when its text is too long.
 *
 * **On by default** wherever the platform can thread: text longer than one
 * post is split rather than refused, unless somebody switched it off for that
 * account (`platformOptions.thread === false`). Never on where the platform
 * cannot thread, so the default cannot raise an error there. The web
 * validator and the worker both decide through this, so what was checked and
 * what is published split the same way.
 */
export function threadRequested(
  platformOptions: Record<string, unknown> | null | undefined,
  capabilities: { thread: { supported: boolean } },
): boolean {
  return capabilities.thread.supported && platformOptions?.['thread'] !== false;
}

/**
 * Whether a thread's posts end with their place (" 2/5").
 *
 * On by default; off only when somebody switched it off for the account
 * (`platformOptions.threadNumbering === false`). Read the same way by the web
 * validator and the worker, because it changes where the text breaks.
 */
export function threadNumbered(
  platformOptions: Record<string, unknown> | null | undefined,
): boolean {
  return platformOptions?.['threadNumbering'] !== false;
}

/** The place marker appended to every part of a thread. */
export function threadMarker(index: number, total: number): string {
  return ` ${index}/${total}`;
}

/**
 * Split `text` into posts of at most `maxLength`, as the platform counts.
 *
 * Returns one element when the text fits. Whitespace inside a part is kept as
 * written; whitespace at a break is dropped, so no part starts or ends blank.
 */
export function splitIntoThread(
  text: string,
  maxLength: number,
  measure: Measure,
  options: { numbered?: boolean | undefined } = {},
): string[] {
  const clean = text.trim();
  if (clean.length === 0 || measure(clean) <= maxLength) return [clean];

  if (options.numbered === false) return pack(clean, maxLength, measure);

  // The marker's width depends on how many parts there turn out to be, which
  // depends on the marker's width. Assume one digit, then two, then three.
  let chunks: string[] = [];
  for (let digits = 1; digits <= 3; digits += 1) {
    const widest = '9'.repeat(digits);
    const reserve = measure(threadMarker(Number(widest), Number(widest)));
    chunks = pack(clean, Math.max(MIN_BUDGET, maxLength - reserve), measure);
    if (String(chunks.length).length <= digits) break;
  }

  return chunks.map((chunk, index) => `${chunk}${threadMarker(index + 1, chunks.length)}`);
}

interface Token {
  /** A run of non-whitespace. */
  word: string;
  /** The whitespace that followed it, possibly empty. */
  gap: string;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /(\S+)(\s*)/gu;
  for (const match of text.matchAll(pattern)) {
    tokens.push({ word: match[1] ?? '', gap: match[2] ?? '' });
  }
  return tokens;
}

/** How good a place to break the gap after this token is. Higher is better. */
function breakQuality(token: Token): number {
  if (/\n\s*\n/u.test(token.gap)) return 3;
  if (token.gap.includes('\n') || SENTENCE_END.test(token.word)) return 2;
  return 1;
}

/**
 * Greedy packing over whitespace-delimited tokens.
 *
 * Measured token by token rather than prefix by prefix: every counting rule a
 * platform has — weights, graphemes, a link's fixed cost — is additive across
 * whitespace, because none of them spans a space. That keeps a long caption
 * linear rather than quadratic.
 */
function pack(text: string, budget: number, measure: Measure): string[] {
  const tokens = tokenize(text);
  const chunks: string[] = [];

  let start = 0;
  while (start < tokens.length) {
    let used = 0;
    let lastFit = -1;
    const breaks: Array<{ index: number; quality: number; used: number }> = [];

    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index] as Token;
      const before = index > start ? measure((tokens[index - 1] as Token).gap) : 0;
      const cost = before + measure(token.word);
      if (used + cost > budget) break;
      used += cost;
      lastFit = index;
      breaks.push({ index, quality: breakQuality(token), used });
    }

    // One word longer than a whole post: cut inside it.
    if (lastFit < start) {
      const token = tokens[start] as Token;
      const [head, rest] = cutWord(token.word, budget, measure);
      chunks.push(head);
      tokens[start] = { word: rest, gap: token.gap };
      continue;
    }

    // Everything left fits.
    if (lastFit === tokens.length - 1) {
      chunks.push(joinTokens(tokens, start, lastFit));
      break;
    }

    // The last place a sentence ends; a bare space only when the sentence
    // in hand is longer than a whole post.
    const best = breaks.filter((b) => b.quality >= 2).at(-1)?.index ?? lastFit;

    chunks.push(joinTokens(tokens, start, best));
    start = best + 1;
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function joinTokens(tokens: readonly Token[], from: number, to: number): string {
  let out = '';
  for (let index = from; index <= to; index += 1) {
    const token = tokens[index] as Token;
    out += index < to ? token.word + token.gap : token.word;
  }
  return out;
}

/** Cut a word with no space in it: after a full stop if one is in reach. */
function cutWord(word: string, budget: number, measure: Measure): [string, string] {
  const graphemes = graphemesOf(word);
  let used = 0;
  let fit = 0;
  let stop = -1;

  for (let index = 0; index < graphemes.length; index += 1) {
    const grapheme = graphemes[index] as string;
    const cost = measure(grapheme);
    if (used + cost > budget) break;
    used += cost;
    fit = index + 1;
    if (CJK_STOP.test(grapheme)) stop = index + 1;
  }

  // Always make progress, even if a single grapheme outweighs the budget.
  const at = stop > 0 ? stop : Math.max(1, fit);
  return [graphemes.slice(0, at).join(''), graphemes.slice(at).join('')];
}

// ── Threads edited by hand ─────────────────────────────────────────────────

/**
 * The line that separates one post from the next in a thread edited by hand.
 *
 * Stored in the account's own text, so the posts somebody wrote are the
 * content: a client reviewing the post sees them, approval locks them, and the
 * content hash covers them. A Markdown rule, so the raw text still reads as
 * "post, then the next post" to anybody who sees it.
 */
export const THREAD_BREAK = '---';

const BREAK_LINE = /\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/;

/** The posts of a thread edited by hand, in order, without empty ones. */
export function splitManualThread(text: string): string[] {
  return `\n${text}\n`
    .split(BREAK_LINE)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** The text that stores these posts as a thread edited by hand. */
export function joinManualThread(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(`\n\n${THREAD_BREAK}\n\n`);
}

/** The same text as one post: the breaks become paragraph breaks. */
export function stripThreadBreaks(text: string): string {
  return splitManualThread(text).join('\n\n');
}

/**
 * Whether the account's posts were edited by hand.
 *
 * Only ever from the account's own text: a thread inherited from the main text
 * has nothing written post by post, and the flag on its own would make the
 * main text be read as hand-made posts.
 */
export function threadIsManual(
  platformOptions: Record<string, unknown> | null | undefined,
  hasOwnText: boolean,
): boolean {
  return hasOwnText && platformOptions?.['threadManual'] === true;
}

/**
 * The thread fields of a draft, decided once for the web validator and the
 * worker, so what is checked and what is published split identically.
 *
 * A thread edited by hand whose splitting has since been switched off is
 * published as one post with the breaks taken out, never with `---` in it.
 */
export function resolveThreadDraft(input: {
  body: string;
  hasOwnText: boolean;
  platformOptions: Record<string, unknown> | null | undefined;
  capabilities: { thread: { supported: boolean } };
}): {
  body: string;
  thread?: true;
  threadNumbering?: false;
  threadManual?: true;
  threadMedia?: Record<string, number>;
  threadPosts?: number;
} {
  const thread = threadRequested(input.platformOptions, input.capabilities);
  const manual = threadIsManual(input.platformOptions, input.hasOwnText);
  const placement = thread ? readThreadMedia(input.platformOptions?.['threadMedia']) : undefined;
  // A count applies to the automatic split; posts edited by hand are what they are.
  const posts =
    thread && !manual ? readThreadPosts(input.platformOptions?.['threadPosts']) : undefined;

  return {
    body: manual && !thread ? stripThreadBreaks(input.body) : input.body,
    ...(thread ? { thread: true as const } : {}),
    ...(thread && !threadNumbered(input.platformOptions)
      ? { threadNumbering: false as const }
      : {}),
    ...(thread && manual ? { threadManual: true as const } : {}),
    ...(placement ? { threadMedia: placement } : {}),
    ...(posts !== undefined ? { threadPosts: posts } : {}),
  };
}

/** A part as shown to be edited: without the " 2/5" the split adds. */
export function withoutThreadMarker(part: string): string {
  return part.replace(/ \d+\/\d+$/, '');
}

// ── Attachments across a thread ────────────────────────────────────────────

/** An attachment as the split sees it. */
export interface ThreadMediaItem {
  id: string;
  kind: string;
}

/** What one post of the platform may carry. */
export interface ThreadMediaLimits {
  maxAttachments: number;
  /** Kinds that must be a post's only attachment (X's video and GIF). */
  soloKinds: readonly string[];
}

/**
 * Which post of a thread each attachment goes with (D-124).
 *
 * An attachment somebody placed on a post stays there (on the last post if the
 * thread has since become shorter). The rest are spread over the posts evenly,
 * in order: five images on a five-post thread go one to each post, seven on
 * three go 3 + 2 + 2 (2026-11-19 — filling the first post first put all five
 * on a Threads thread's first post, which takes up to twenty, and left the
 * replies bare). An attachment moves on to a later post when its post is full,
 * when it must be alone, or when the post already holds one that must be.
 * Anything that still does not fit lands on the last post, where the validator
 * names it.
 *
 * The validator, the adapters and the composer all ask this one function.
 */
export function assignThreadMedia<M extends ThreadMediaItem>(
  media: readonly M[],
  partCount: number,
  assignment: Readonly<Record<string, number>> | null | undefined,
  limits: ThreadMediaLimits,
): M[][] {
  const groups: M[][] = Array.from({ length: Math.max(1, partCount) }, () => []);
  const last = groups.length - 1;
  const unplaced: M[] = [];

  for (const item of media) {
    const at = assignment?.[item.id];
    if (typeof at === 'number' && Number.isInteger(at) && at >= 0) {
      (groups[Math.min(at, last)] as M[]).push(item);
    } else {
      unplaced.push(item);
    }
  }

  const solo = (item: M) => limits.soloKinds.includes(item.kind);
  const fits = (group: readonly M[], item: M) =>
    group.length < limits.maxAttachments &&
    (group.length === 0 || (!solo(item) && !group.some(solo)));

  // The post each attachment is aimed at: n over p posts gives the first
  // n mod p posts one more than the rest — one each while n ≤ p.
  const base = Math.floor(unplaced.length / groups.length);
  const extra = unplaced.length % groups.length;
  const aims: number[] = [];
  groups.forEach((_, post) => {
    for (let k = 0; k < base + (post < extra ? 1 : 0); k += 1) aims.push(post);
  });

  // Never earlier than the one before, so the order holds when one moves on.
  let cursor = 0;
  unplaced.forEach((item, i) => {
    cursor = Math.max(cursor, aims[i] ?? last);
    while (cursor < last && !fits(groups[cursor] as M[], item)) cursor += 1;
    (groups[cursor] as M[]).push(item);
  });

  return groups;
}

/** A stored placement, kept to what it can mean: attachment id → post index. */
export function readThreadMedia(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isInteger(entry[1]) && entry[1] >= 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// ── A chosen number of posts ────────────────────────────────────────────────

/**
 * How many posts this text can become, for offering a choice (D-124).
 *
 * `auto` is the split with no count asked for, every post ending at a
 * sentence. `min` is the fewest posts the text fits in at all, as the owner
 * asked (2026-11-19): 1,946 characters at 500 a post is offered as 4, not only
 * the 5 it takes at sentence ends. `sentenceMin` is the fewest at sentence
 * ends — below it, a post may have to end between words, which the person
 * adjusts by editing the posts. `max` is one post per sentence, capped by the
 * platform's ceiling.
 */
export interface ThreadCountRange {
  auto: number;
  min: number;
  sentenceMin: number | null;
  max: number;
}

function budgetFor(maxLength: number, measure: Measure, count: number, numbered: boolean): number {
  return numbered
    ? Math.max(MIN_BUDGET, maxLength - measure(threadMarker(count, count)))
    : maxLength;
}

/** The fewest posts, breaking only where `quality` allows; Infinity if impossible. */
function fewestPosts(
  tokens: readonly Token[],
  budget: number,
  measure: Measure,
  quality: number,
): number {
  let count = 0;
  let start = 0;
  while (start < tokens.length) {
    let used = 0;
    let lastBreak = -1;
    for (let index = start; index < tokens.length; index += 1) {
      const token = tokens[index] as Token;
      const before = index > start ? measure((tokens[index - 1] as Token).gap) : 0;
      used += before + measure(token.word);
      if (used > budget) break;
      if (index === tokens.length - 1 || breakQuality(token) >= quality) lastBreak = index;
    }
    if (lastBreak < start) return Number.POSITIVE_INFINITY;
    count += 1;
    start = lastBreak + 1;
  }
  return count;
}

export function threadCountRange(
  text: string,
  maxLength: number,
  measure: Measure,
  options: { numbered?: boolean | undefined; maxPosts: number },
): ThreadCountRange | null {
  const clean = text.trim();
  if (clean.length === 0 || measure(clean) <= maxLength) return null;

  const numbered = options.numbered !== false;
  const tokens = tokenize(clean);
  // Counts below ten carry a one-digit marker; the range is worked out at that
  // width, and a count of ten or more is checked exactly when it is chosen.
  const budget = budgetFor(maxLength, measure, 9, numbered);

  // The fewest posts the text fits in at all, breaking between any two words.
  const min = fewestPosts(tokens, budget, measure, 1);
  if (!Number.isFinite(min)) return null; // a single word longer than a post

  const sentences = fewestPosts(tokens, budget, measure, 2);
  const boundaries = tokens.slice(0, -1).filter((token) => breakQuality(token) >= 2).length;
  const auto = splitIntoThread(clean, maxLength, measure, { numbered }).length;

  return {
    auto,
    min: Math.max(2, min),
    sentenceMin: Number.isFinite(sentences) ? sentences : null,
    max: Math.min(
      options.maxPosts,
      Number.isFinite(sentences) ? Math.max(boundaries + 1, sentences) : auto,
    ),
  };
}

/**
 * Split into exactly `count` posts, or null if the text does not fit in that
 * many.
 *
 * Posts end where sentences end wherever the count allows: the split cuts as
 * few sentences as it possibly can — none when it can — and only then makes
 * the posts as even as possible, so a thread of five is five similar posts
 * rather than four full ones and a stub. Where a count is fewer than the text
 * takes at sentence ends, a post ends between words, and the person adjusts
 * it by editing the posts.
 */
export function splitIntoThreadCount(
  text: string,
  maxLength: number,
  measure: Measure,
  count: number,
  options: { numbered?: boolean | undefined } = {},
): string[] | null {
  const clean = text.trim();
  if (!Number.isInteger(count) || count < 2) return null;

  const numbered = options.numbered !== false;
  const budget = budgetFor(maxLength, measure, count, numbered);
  const tokens = tokenize(clean);
  const total = tokens.length;
  if (count > total) return null;

  const words = tokens.map((token) => measure(token.word));
  const gaps = tokens.map((token) => measure(token.gap));
  const sentenceEnd = tokens.map((token) => breakQuality(token) >= 2);
  const prefix = [0];
  for (let index = 0; index < total; index += 1) {
    prefix.push((prefix[index] as number) + (words[index] as number) + (gaps[index] as number));
  }
  // Tokens first..last as one post: their words and the gaps between them.
  const cost = (first: number, last: number) =>
    (prefix[last + 1] as number) - (prefix[first] as number) - (gaps[last] as number);

  interface Cell {
    /** Posts so far that end mid-sentence. */
    cuts: number;
    longest: number;
    from: number;
  }
  const better = (a: Cell, b: Cell | undefined) =>
    !b || a.cuts < b.cuts || (a.cuts === b.cuts && a.longest < b.longest);

  // best[n][last]: the first `n` posts end with token `last`.
  const best: Array<Array<Cell | undefined>> = Array.from(
    { length: count + 1 },
    () => new Array<Cell | undefined>(total),
  );
  for (let last = 0; last < total; last += 1) {
    const length = cost(0, last);
    if (length > budget) break;
    best[1]![last] = { cuts: 0, longest: length, from: -1 };
  }

  for (let n = 2; n <= count; n += 1) {
    for (let last = n - 1; last < total; last += 1) {
      for (let first = last; first >= n - 1; first -= 1) {
        const length = cost(first, last);
        if (length > budget) break;
        const previous = best[n - 1]![first - 1];
        if (!previous) continue;
        const candidate: Cell = {
          cuts: previous.cuts + (sentenceEnd[first - 1] ? 0 : 1),
          longest: Math.max(previous.longest, length),
          from: first,
        };
        if (better(candidate, best[n]![last])) best[n]![last] = candidate;
      }
    }
  }

  if (!best[count]![total - 1]) return null;

  const chunks: string[] = [];
  let last = total - 1;
  for (let n = count; n >= 1; n -= 1) {
    const cell = best[n]![last] as Cell;
    const first = cell.from === -1 ? 0 : cell.from;
    chunks.unshift(joinTokens(tokens, first, last));
    last = first - 1;
  }

  return numbered
    ? chunks.map((chunk, index) => `${chunk}${threadMarker(index + 1, chunks.length)}`)
    : chunks;
}

/** A stored count, kept to what it can mean: two posts or more. */
export function readThreadPosts(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 ? value : undefined;
}

// ── Progress, for resuming a thread that stopped part-way ──────────────────

/**
 * One published part, as the adapter needs to point at it again.
 *
 * `id` is the platform's post id. `ref` is whatever else replying to it takes —
 * Bluesky addresses a reply by content id as well as by uri — and is left
 * unset where nothing else is needed.
 */
export interface ThreadLink {
  id: string;
  ref?: string | undefined;
}

/**
 * What an adapter records after every part, so a retry continues the thread
 * instead of starting it again.
 *
 * Stored inside the adapter's `providerRef`, under `thread`. `fingerprint`
 * names the exact parts being published: a retry whose parts differ — the
 * text was edited in between — must not be stitched onto the old thread.
 */
export interface ThreadProgress {
  fingerprint: string;
  total: number;
  posted: ThreadLink[];
}

/**
 * A stable fingerprint of a thread's parts. Not a security boundary — it only
 * has to tell one draft's split from another's — so a fast string hash will do
 * and the module stays free of Node built-ins.
 */
export function threadFingerprint(parts: readonly string[]): string {
  const text = JSON.stringify(parts);
  // cyrb53: 53 bits, good distribution, no dependencies.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${parts.length}:${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

/**
 * Read the progress an earlier attempt recorded.
 *
 *   • `undefined` — nothing usable was recorded; start from the first post.
 *   • `'CHANGED'` — part of a thread is already live, but for different text.
 *     The caller must refuse: publishing would start a second thread.
 *   • a progress — continue from `posted.length`.
 */
export function readThreadProgress(
  previousRef: Record<string, unknown> | undefined,
  fingerprint: string,
): ThreadProgress | 'CHANGED' | undefined {
  const raw = previousRef?.['thread'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const { fingerprint: recorded, total, posted } = raw as Record<string, unknown>;
  if (typeof recorded !== 'string' || typeof total !== 'number' || !Array.isArray(posted)) {
    return undefined;
  }

  const links = posted.filter(
    (link): link is ThreadLink =>
      typeof link === 'object' &&
      link !== null &&
      typeof (link as ThreadLink).id === 'string' &&
      ((link as ThreadLink).ref === undefined || typeof (link as ThreadLink).ref === 'string'),
  );
  if (links.length !== posted.length) return undefined;

  if (recorded !== fingerprint) return links.length > 0 ? 'CHANGED' : undefined;
  return { fingerprint, total, posted: links };
}
