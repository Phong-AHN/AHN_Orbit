/**
 * Which per-post settings a platform still needs, and whether they are there.
 *
 * ## Why this file exists
 *
 * Three platforms make a post carry a setting that no other platform has, and
 * that Orbit deliberately refuses to choose on a client's behalf:
 *
 *   • **TikTok** — the visibility, which must come from what the creator's own
 *     account currently allows (**D-086**).
 *   • **YouTube** — the made-for-kids declaration, which is a statement under
 *     COPPA rather than a preference (**D-090**).
 *   • **Pinterest** — the board a pin is filed on, plus a cover image for a
 *     video pin (**D-091**).
 *
 * Each of those is enforced inside its adapter at publish time. That is correct
 * — the adapter is the only thing that knows the platform — but it means a post
 * composed for five accounts at once can look finished and then fail at its
 * scheduled time for a reason nobody was shown. **This module is what lets the
 * composer say so up front, for every selected account at the same time.**
 *
 * ## About the platform names in here
 *
 * `docs/ARCHITECTURE.md` forbids `if (platform === 'X')` outside the provider
 * directory, and this file breaks that letter deliberately, in one place rather
 * than scattered through the composer. Two reasons it is the least-bad option
 * today:
 *
 *   1. The capability descriptor has no vocabulary for "requires a per-post
 *      setting" yet. Teaching it one is the real fix and is written up as the
 *      open gap in **D-091** — it touches all seven adapters, so it is a
 *      decision to take rather than something to slip in here.
 *   2. Everything below is *presentation*: which panel to draw and which
 *      sentence to show. **Nothing here decides whether a post may publish.**
 *      The adapter still refuses, server-side, whatever this file says — so the
 *      worst a mistake here can do is show the wrong prompt, never publish
 *      something that should have been refused.
 *
 * Kept free of `@/` imports so it is unit-testable: the root Vitest config does
 * not resolve that alias.
 */

/** A setting a platform requires, described for a person rather than an API. */
export interface RequiredSetting {
  /** Stable id, for keys and tests. */
  id: string;
  /** What to tell somebody is missing. A sentence fragment, not a field name. */
  label: string;
}

export type PlatformOptions = Record<string, unknown> | null | undefined;

/** Media as the composer holds it, which is all this needs to see. */
export interface AttachmentSummary {
  kind: string;
}

/** Platforms that ask a post for something before it can go out. */
const REQUIRES_SETTINGS = new Set(['TIKTOK', 'YOUTUBE', 'PINTEREST']);

export function requiresPlatformSettings(platform: string): boolean {
  return REQUIRES_SETTINGS.has(platform.toUpperCase());
}

/**
 * What this account still needs before it can publish.
 *
 * Empty means nothing is outstanding. The order is the order somebody should
 * deal with them in, not alphabetical.
 *
 * `media` matters for exactly one rule — Pinterest's cover image — and is
 * accepted rather than inferred because the composer's live attachments are the
 * truth on screen, which is what somebody is looking at while they fix it.
 */
export function missingPlatformSettings(input: {
  platform: string;
  options: PlatformOptions;
  media: readonly AttachmentSummary[];
}): RequiredSetting[] {
  const platform = input.platform.toUpperCase();
  const options = input.options ?? {};
  const missing: RequiredSetting[] = [];

  if (platform === 'TIKTOK') {
    /**
     * Upload mode carries no visibility at all — the creator picks it in
     * TikTok's own editor — so asking for one here would be asking for
     * something that is never sent.
     */
    const mode = options['postMode'];
    if (mode !== 'MEDIA_UPLOAD' && typeof options['privacyLevel'] !== 'string') {
      missing.push({ id: 'privacyLevel', label: 'who can see this video' });
    }
  }

  if (platform === 'YOUTUBE') {
    // Deliberately `!== 'boolean'`: `false` is a real, complete answer. Testing
    // for falsiness would treat "no, not made for kids" as unanswered.
    if (typeof options['madeForKids'] !== 'boolean') {
      missing.push({ id: 'madeForKids', label: 'whether it is made for children' });
    }
  }

  if (platform === 'PINTEREST') {
    if (typeof options['boardId'] !== 'string' || options['boardId'].length === 0) {
      missing.push({ id: 'boardId', label: 'which board to pin it to' });
    }

    /**
     * A video pin needs a cover image and Pinterest will not take a frame from
     * the video. Only raised once a video is actually attached — an empty post
     * is not yet wrong, and a warning on a post nobody has finished composing
     * is noise.
     */
    const hasVideo = input.media.some((item) => item.kind.toUpperCase() === 'VIDEO');
    const hasImage = input.media.some((item) => {
      const kind = item.kind.toUpperCase();
      return kind === 'IMAGE' || kind === 'GIF';
    });

    if (hasVideo && !hasImage) {
      missing.push({ id: 'coverImage', label: 'a cover image for the video' });
    }
  }

  return missing;
}

/**
 * One line for a whole post: how many of its accounts are still unfinished.
 *
 * Returns null when there is nothing to say, so a caller can render nothing
 * rather than "0 accounts need attention" — which is a sentence that makes
 * somebody look for a problem that is not there.
 */
export function summariseMissingSettings(
  variants: ReadonlyArray<{ platform: string; accountName: string; missing: RequiredSetting[] }>,
): string | null {
  const unfinished = variants.filter((variant) => variant.missing.length > 0);
  if (unfinished.length === 0) return null;

  if (unfinished.length === 1) {
    const only = unfinished[0] as (typeof unfinished)[number];
    return `${only.accountName} still needs ${joinList(only.missing.map((m) => m.label))}.`;
  }

  return `${unfinished.length} accounts still need settings before this post can publish.`;
}

/** "a, b and c" — an Oxford-comma-free list, because it is read aloud in a UI. */
export function joinList(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
}
