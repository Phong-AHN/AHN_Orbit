import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Load the monorepo-root `.env` for local development.
 *
 * Tools disagree about where the project root is: Next.js looks in
 * `apps/web`, the worker looks in `apps/worker`, Prisma looks in the cwd. One
 * `.env` at the workspace root is the only arrangement that does not involve
 * copies drifting apart.
 *
 * Three rules keep this safe:
 *   • a variable already present in `process.env` is never overwritten, so a
 *     real deployment's injected configuration always wins;
 *   • nothing is loaded when `APP_ENV`/`NODE_ENV` is production — deployed
 *     environments inject configuration, they do not read files;
 *   • under `NODE_ENV=test`, `.env.test` is read first and therefore wins.
 *
 * That last rule is not a convenience. `.env` holds whatever infrastructure
 * this machine is pointed at, and once that is a hosted database, an
 * integration run — which creates and deletes organizations — would do it
 * there. The protection has to be structural: a test run must not depend on
 * someone remembering to export an override first.
 */

let loaded = false;

export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;

  if (process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production') return;

  const root = findWorkspaceRoot();
  if (!root) return;

  // Order matters: the first file to define a key owns it, so the test
  // overrides are read before the ambient `.env`.
  const files = process.env.NODE_ENV === 'test' ? ['.env.test', '.env'] : ['.env'];

  for (const name of files) {
    const file = join(root, name);
    if (!existsSync(file)) continue;

    for (const [key, value] of parseDotenv(readFileSync(file, 'utf8'))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

/** Walk up looking for the pnpm workspace manifest. */
function findWorkspaceRoot(from: string = process.cwd()): string | undefined {
  let current = resolve(from);

  for (let depth = 0; depth < 10; depth++) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

/**
 * Minimal `.env` parser — `KEY=value`, `#` comments, optional quotes, and `\n`
 * escapes inside double quotes (which is how the Firebase private key is
 * carried). Deliberately not a dependency: the format we actually use is this
 * small, and this runs before anything else in the process.
 */
export function parseDotenv(contents: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing inline comment from an unquoted value.
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    entries.push([key, value]);
  }

  return entries;
}
