/**
 * What a file *is*, what each platform *wants*, and which file an error is about.
 *
 * ## This file describes. It never decides.
 *
 * `/validate` runs the real engine server-side against the full capability
 * descriptor, and that is the only thing allowed to say whether a post can go
 * out. Everything here is presentation: turning verified numbers into a
 * sentence, turning a constraint into a sentence, and reading an index out of a
 * field name so the server's own verdict can sit next to the file it is about.
 *
 * The distinction matters because the one thing this feature must not become is
 * a second validation engine in the browser, disagreeing with the first. So
 * there is deliberately **no function here that returns a pass or a fail** —
 * every verdict on screen comes from the server's issue list.
 *
 * ## Why it exists at all
 *
 * The composer could already tell somebody a post was invalid, and could not
 * tell them what the platform wanted or what their file actually was. That gap
 * cost real time: a 30fps video refused by TikTok for its frame rate, with
 * nothing on screen saying TikTok wanted 23–60 or that the file's *peak* rate
 * was 62 (**D-086**). The facts and the requirement were both known and
 * neither was shown.
 *
 * ## Why it lives in the media feature
 *
 * The composer is what displays all this, so posts/ui would be the obvious
 * home — but `posts/ui/composer.tsx` already imports `MediaPanel` from here,
 * and the panel needs `describeFacts` to label each attachment. Putting the
 * module in posts would make the two features import each other, and a cycle in
 * a client bundle resolves to `undefined` at runtime rather than failing
 * honestly at build time. Media is the lower layer; the facts belong in it.
 *
 * No `@/` imports, so this is unit testable — the root Vitest config does not
 * resolve that alias.
 */

/** The verified facts about one attachment, as the composer holds them. */
export interface MediaFacts {
  kind: string;
  mimeType: string;
  sizeBytes?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  durationMs?: number | undefined;
  frameRate?: number | undefined;
  /** The figure platforms object to. See the note in the schema. */
  peakFrameRate?: number | undefined;
}

/** One media constraint from a capability descriptor, for display. */
export interface MediaConstraintView {
  mimeTypes: readonly string[];
  maxBytes: number;
  minWidth?: number | undefined;
  minHeight?: number | undefined;
  maxWidth?: number | undefined;
  maxHeight?: number | undefined;
  /** Width ÷ height, inclusive. */
  minAspectRatio?: number | undefined;
  maxAspectRatio?: number | undefined;
  minDurationMs?: number | undefined;
  maxDurationMs?: number | undefined;
  minFrameRate?: number | undefined;
  maxFrameRate?: number | undefined;
}

export interface MediaCapabilityView {
  image: MediaConstraintView | null;
  video: MediaConstraintView | null;
  gif: MediaConstraintView | null;
  maxAttachments: number;
  allowsMixedKinds: boolean;
  required: boolean;
  altText: boolean;
}

// ── Mapping a server issue back to the file it is about ─────────────────────

/**
 * The index inside a validation issue's `field`.
 *
 * The engine already names the offending attachment — `media[2]` — so an error
 * can sit on the file it concerns without anything in the browser working out
 * which file that is. `'media'` with no index is about the set as a whole (a
 * platform that requires media and got none), and returns null.
 */
export function mediaIndexFromField(field: string): number | null {
  const match = /^media\[(\d+)\]$/.exec(field);
  if (!match) return null;

  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/** The shape of a validation issue this module needs. */
export interface IssueLike {
  severity: 'ERROR' | 'WARNING';
  field: string;
  message: string;
}

/** One issue, ready to render: whose it is and which file it concerns. */
export interface PinnedIssue {
  severity: 'ERROR' | 'WARNING';
  message: string;
  /** The account that raised it, or null for an issue about the whole post. */
  where: string | null;
  /** The attachment index, or null when it is about the attachment set. */
  index: number | null;
}

/**
 * Flatten a validation response down to the media issues, each pinned to the
 * file it is about.
 *
 * Two things here are easy to get wrong and both are silent, which is why this
 * is a function with tests rather than a filter inline in the component:
 *
 * - **Non-media issues must not leak in.** A text-length error shown under a
 *   photograph is worse than not showing it, and the Checks card already lists
 *   every issue.
 * - **A set-level issue must not be pinned to the first file.** "This platform
 *   requires an image" carries `field: 'media'`, and attaching it to
 *   attachment 1 would blame a file for the absence of a file.
 *
 * It sorts nothing and decides nothing — the messages are the server's own.
 */
export function pinMediaIssues(
  postIssues: readonly IssueLike[],
  variants: ReadonlyArray<{ accountName: string; issues: readonly IssueLike[] }>,
): PinnedIssue[] {
  const all: Array<{ issue: IssueLike; where: string | null }> = [
    ...postIssues.map((issue) => ({ issue, where: null })),
    ...variants.flatMap((variant) =>
      variant.issues.map((issue) => ({ issue, where: variant.accountName })),
    ),
  ];

  return all
    .filter(({ issue }) => issue.field === 'media' || mediaIndexFromField(issue.field) !== null)
    .map(({ issue, where }) => ({
      severity: issue.severity,
      message: issue.message,
      where,
      index: mediaIndexFromField(issue.field),
    }));
}

/**
 * The severity to colour a file by, or null when nothing was said about it.
 *
 * An error outranks a warning, so a file with both reads as refused rather than
 * merely questionable.
 */
export function worstSeverity(issues: readonly PinnedIssue[]): 'ERROR' | 'WARNING' | null {
  if (issues.some((issue) => issue.severity === 'ERROR')) return 'ERROR';
  return issues.length > 0 ? 'WARNING' : null;
}

// ── Describing a file ───────────────────────────────────────────────────────

/** `8.00` → `8`, `1.50` → `1.5`. A trailing zero is noise in a limit. */
function trimZeros(value: number, places: number): string {
  const fixed = value.toFixed(places);
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * `8388608` → `8 MB`.
 *
 * **Binary multiples, labelled the way the platforms label them.** This was
 * decimal first and it made every published limit unrecognisable: Facebook
 * documents 8 MB and 100 MB for images and video, the descriptor stores those
 * as 8 MiB and 100 MiB, and dividing by a million displayed them as "8.4 MB"
 * and "104.9 MB". Nobody can check a file against a limit they have never seen
 * written down.
 *
 * A file's own size uses this too, so the size and the ceiling it is compared
 * against are always in the same unit.
 */
export function formatBytes(bytes: number): string {
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;

  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${trimZeros(bytes / KB, 0)} KB`;
  if (bytes < GB) return `${trimZeros(bytes / MB, 1)} MB`;
  return `${trimZeros(bytes / GB, 2)} GB`;
}

/** `90_000` → `1:30`. Seconds are what a person compares against a limit. */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * `0.5625` → `9:16`, `1.91` → `1.91:1`.
 *
 * Named ratios first, because that is how the requirement is written down
 * everywhere else — a platform's own documentation says 4:5, never 0.8, and
 * somebody checking their file against it should not have to divide.
 */
export function formatAspectRatio(ratio: number): string {
  const named: Array<[number, string]> = [
    [1, '1:1'],
    [16 / 9, '16:9'],
    [9 / 16, '9:16'],
    [4 / 5, '4:5'],
    [5 / 4, '5:4'],
    [4 / 3, '4:3'],
    [3 / 4, '3:4'],
    [2 / 3, '2:3'],
    [3 / 2, '3:2'],
  ];

  for (const [value, label] of named) {
    // 0.5% — close enough that a rounded pixel dimension still matches, far
    // enough that 1.91:1 is never mislabelled as 16:9 (they are 7% apart).
    if (Math.abs(ratio - value) / value < 0.005) return label;
  }

  // Trimmed, because a Facebook descriptor's 0.5–2.0 bounds rendered as
  // "1:2.00–2.00:1", which says 2:1 the long way round.
  return ratio >= 1 ? `${trimZeros(ratio, 2)}:1` : `1:${trimZeros(1 / ratio, 2)}`;
}

/**
 * What this file is, in the order somebody would read it out.
 *
 * **The peak frame rate is shown beside the average whenever they differ**, and
 * that is the whole reason this function exists. A phone records variable frame
 * rate by default: the file says 30, the average is 30, and the instantaneous
 * rate spikes past any ceiling — which is the figure the platform's own checker
 * reads. Showing only the average leaves somebody certain their 30fps video was
 * refused for being 30fps.
 */
export function describeFacts(facts: MediaFacts): string[] {
  const parts: string[] = [];

  if (facts.width && facts.height) {
    // The ratio rides along with the dimensions rather than standing alone:
    // it is the form the platform states its limit in, and a refusal for
    // MEDIA_ASPECT_TOO_TALL is unreadable without it.
    parts.push(
      `${facts.width} × ${facts.height} (${formatAspectRatio(facts.width / facts.height)})`,
    );
  }
  if (facts.durationMs !== undefined) parts.push(formatDuration(facts.durationMs));

  if (facts.frameRate !== undefined) {
    const average = Math.round(facts.frameRate * 10) / 10;
    const peak = facts.peakFrameRate === undefined ? undefined : Math.round(facts.peakFrameRate);

    // A whole frame apart is the threshold the upload check already uses for
    // "this is variable frame rate", so the two agree about when it matters.
    parts.push(
      peak !== undefined && peak > average + 1
        ? `${average} fps average, ${peak} fps peak`
        : `${average} fps`,
    );
  }

  if (facts.sizeBytes !== undefined) parts.push(formatBytes(facts.sizeBytes));

  return parts;
}

/** `video/quicktime` → `MOV`. The subtype is what a person recognises. */
export function formatType(mimeType: string): string {
  const subtype = mimeType.split('/')[1] ?? mimeType;
  const friendly: Record<string, string> = {
    quicktime: 'MOV',
    jpeg: 'JPG',
    'svg+xml': 'SVG',
  };
  return (friendly[subtype] ?? subtype).toUpperCase();
}

// ── Describing what a platform wants ────────────────────────────────────────

/**
 * One line saying what kind of post this platform will accept.
 *
 * Said first and separately because it is the requirement people get wrong:
 * YouTube has no image post at all, and the composer used to accept one and
 * let the worker refuse it hours later (**D-090**).
 */
export function describeMediaNeed(media: MediaCapabilityView): string {
  const kinds: string[] = [];
  if (media.image) kinds.push('images');
  if (media.video) kinds.push('video');
  // A separate `gif` constraint is rare — most platforms fold image/gif into
  // their image types — but a descriptor that sets one means a GIF is accepted
  // on terms of its own, and leaving it out would read as "not supported".
  if (media.gif) kinds.push('GIFs');

  if (kinds.length === 0) return 'Text only — no attachments.';

  const list = kinds.join(' or ');
  const limit =
    media.maxAttachments === 1 ? 'one attachment' : `up to ${media.maxAttachments} attachments`;

  return media.required
    ? `Needs ${list} — ${limit}.`
    : `Optional ${list} — ${limit}.`;
}

/**
 * The constraints for one media kind, each as its own line.
 *
 * Lines rather than a sentence: somebody comparing a file against a limit reads
 * down a list, and a paragraph makes them hunt. An absent constraint produces
 * no line at all — "no maximum duration" is noise, and a platform that states
 * nothing should say nothing.
 */
export function describeConstraint(constraint: MediaConstraintView): string[] {
  const lines: string[] = [];

  const types = constraint.mimeTypes.map(formatType).join(', ');
  if (types) lines.push(`Format: ${types}`);

  lines.push(`Up to ${formatBytes(constraint.maxBytes)}`);

  if (constraint.minDurationMs !== undefined || constraint.maxDurationMs !== undefined) {
    const from =
      constraint.minDurationMs === undefined ? null : formatDuration(constraint.minDurationMs);
    const to =
      constraint.maxDurationMs === undefined ? null : formatDuration(constraint.maxDurationMs);

    lines.push(
      from && to ? `Length ${from}–${to}` : from ? `At least ${from}` : `At most ${to as string}`,
    );
  }

  if (constraint.minFrameRate !== undefined || constraint.maxFrameRate !== undefined) {
    const low = constraint.minFrameRate;
    const high = constraint.maxFrameRate;

    // Named as the peak, because that is what is checked — against the file's
    // highest instantaneous rate, not its average.
    lines.push(
      low !== undefined && high !== undefined
        ? `Frame rate ${low}–${high} fps, measured at the peak`
        : low !== undefined
          ? `At least ${low} fps`
          : `At most ${high as number} fps, measured at the peak`,
    );
  }

  if (constraint.minWidth !== undefined || constraint.minHeight !== undefined) {
    lines.push(`At least ${constraint.minWidth ?? '—'} × ${constraint.minHeight ?? '—'}`);
  }

  if (constraint.maxWidth !== undefined || constraint.maxHeight !== undefined) {
    lines.push(`At most ${constraint.maxWidth ?? '—'} × ${constraint.maxHeight ?? '—'}`);
  }

  if (constraint.minAspectRatio !== undefined || constraint.maxAspectRatio !== undefined) {
    const tallest =
      constraint.minAspectRatio === undefined
        ? null
        : formatAspectRatio(constraint.minAspectRatio);
    const widest =
      constraint.maxAspectRatio === undefined
        ? null
        : formatAspectRatio(constraint.maxAspectRatio);

    lines.push(
      tallest && widest
        ? `Aspect ${tallest}–${widest}`
        : tallest
          ? `No taller than ${tallest}`
          : `No wider than ${widest as string}`,
    );
  }

  return lines;
}
