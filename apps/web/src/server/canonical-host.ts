/**
 * The one host the product is used on in production.
 *
 * Every OAuth redirect URI is built from `APP_URL`, and the cookies that carry
 * the session and the OAuth nonce belong to whichever host set them. A person
 * who opens the app on `ahn-orbit-web.vercel.app` starts a connect flow there,
 * the platform sends them back to `www.anhoi.co`, and neither cookie came
 * along: every platform fails with "OAuth state verification failed".
 *
 * So pages are moved to the canonical host before anything starts. Only pages:
 * an API route can be the target of a webhook or a machine client, and a
 * redirect there would break the caller rather than steer a person.
 *
 * Kept free of Next.js so it can be tested exactly.
 */

/** Paths that are never moved: APIs, framework assets and discovery documents. */
const NEVER_MOVED = ['/api/', '/_next/', '/.well-known/'];

export function canonicalRedirect(input: {
  url: URL;
  method: string;
  appUrl: string | undefined;
  vercelEnv: string | undefined;
}): string | null {
  // Production only. A preview deployment lives on its own host by design.
  if (input.vercelEnv !== 'production' || !input.appUrl) return null;
  if (input.method !== 'GET' && input.method !== 'HEAD') return null;

  let canonical: URL;
  try {
    canonical = new URL(input.appUrl);
  } catch {
    return null;
  }

  if (input.url.host === canonical.host) return null;
  if (NEVER_MOVED.some((prefix) => input.url.pathname.startsWith(prefix))) return null;

  return `${canonical.origin}${input.url.pathname}${input.url.search}`;
}
