/**
 * Which commit this process was built from.
 *
 * A deploy can be skipped without anything saying so: Railway's watch paths
 * passed over every commit that changed only `packages/`, so a provider fix sat
 * on `main` for a day while the worker ran the build before it, and from the
 * outside a fix that had not shipped looks exactly like a fix that did not work.
 * Stamped on each failed attempt so the record itself answers that.
 *
 * Only the commit: attempts are readable by the tenant, and the repository's
 * history is the one piece of this that is not internal.
 */
export function workerBuild(env: Record<string, string | undefined> = process.env): {
  workerCommit?: string;
} {
  const commit = env['RAILWAY_GIT_COMMIT_SHA']?.slice(0, 7);
  return commit ? { workerCommit: commit } : {};
}
