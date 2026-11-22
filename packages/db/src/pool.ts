/**
 * The size of a process's database pool (2026-11-23).
 *
 * Prisma takes it from `connection_limit` in the connection URL. The URL
 * Supabase hands out for serverless use carries `connection_limit=1` — right
 * for a Vercel function, which serves one request, and wrong for the worker,
 * which runs eight publishes at once beside every sweep. With one connection
 * between them, queries waited past Prisma's ten-second pool timeout (P2024):
 * a publish claimed its variant and then could not load it, nor hand the claim
 * back, and the post sat in "Publishing" with no attempt ever made.
 *
 * `DATABASE_CONNECTION_LIMIT` sets the pool for one process without editing
 * the URL, which holds the database password. Pure, and kept apart from the
 * client so it can be tested without one.
 */

/**
 * The URL with its `connection_limit` set to `limit`, or unchanged without
 * one.
 *
 * Only the query string is rewritten. Everything before the `?` — user,
 * password, host — is passed through byte for byte, because re-serialising a
 * URL can re-encode a password and silently break the connection.
 */
export function withConnectionLimit(url: string, limit: number | undefined): string {
  if (limit === undefined) return url;

  const at = url.indexOf('?');
  const base = at === -1 ? url : url.slice(0, at);
  const params = new URLSearchParams(at === -1 ? '' : url.slice(at + 1));
  params.set('connection_limit', String(limit));
  return `${base}?${params.toString()}`;
}

/**
 * The pool size a URL asks for, or `undefined` when it leaves it to Prisma
 * (which then uses the machine's CPU count × 2 + 1).
 */
export function connectionLimitOf(url: string): number | undefined {
  const at = url.indexOf('?');
  if (at === -1) return undefined;
  const raw = new URLSearchParams(url.slice(at + 1)).get('connection_limit');
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
