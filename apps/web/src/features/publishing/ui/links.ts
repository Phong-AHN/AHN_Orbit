/**
 * Where a published post lives, made safe to put in a link.
 *
 * A post's permalink usually comes from the platform, but not always: when
 * somebody resolves a publish Orbit could not confirm, they may type the link
 * in themselves. The contract checks it is a URL, and a URL is not the same as
 * a web address — `javascript:alert(1)` parses as one. Anything rendered as an
 * `href` therefore passes through here, and only `http` and `https` survive.
 */
export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

const PLATFORM_NAMES: Record<string, string> = {
  FACEBOOK: 'Facebook',
  INSTAGRAM: 'Instagram',
  THREADS: 'Threads',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  LINKEDIN: 'LinkedIn',
  PINTEREST: 'Pinterest',
};

/** "YouTube", not "Youtube": brand names are not title case. */
export function platformName(platform: string): string {
  return PLATFORM_NAMES[platform] ?? platform.charAt(0) + platform.slice(1).toLowerCase();
}
