/**
 * Slug generation.
 *
 * Slugs appear in URLs and, for organizations, are the tenant reference the
 * router resolves. They are therefore generated server-side from the name and
 * never accepted verbatim from a client — a caller-chosen slug is a chance to
 * collide with or impersonate another tenant's URL.
 */

const RESERVED = new Set([
  'api',
  'admin',
  'app',
  'portal',
  'auth',
  'login',
  'logout',
  'signin',
  'signup',
  'settings',
  'new',
  'me',
  'health',
  'static',
  '_next',
  'orbit',
  'support',
  'help',
  'billing',
  'webhooks',
]);

export function slugify(input: string): string {
  const base = input
    .normalize('NFKD')
    // Strip combining marks so "Café" becomes "cafe" rather than "caf".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');

  return base.length >= 2 ? base : '';
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED.has(slug);
}

/**
 * Find a free slug by appending a counter.
 *
 * `exists` is supplied by the caller so this stays pure and testable, and so
 * the uniqueness scope is explicit — organization slugs are globally unique,
 * workspace and brand slugs only within their parent.
 */
export async function uniqueSlug(
  desired: string,
  exists: (candidate: string) => Promise<boolean>,
  fallback = 'workspace',
): Promise<string> {
  const base = slugify(desired) || fallback;

  for (let suffix = 0; suffix < 100; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    if (isReservedSlug(candidate)) continue;
    if (!(await exists(candidate))) return candidate;
  }

  // Deterministic attempts exhausted; fall back to something certainly free.
  return `${base}-${Date.now().toString(36)}`;
}
