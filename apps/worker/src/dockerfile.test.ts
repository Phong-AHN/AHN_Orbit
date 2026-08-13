import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The container's manifest list must match the worker's real dependencies.
 *
 * The `deps` stage copies `package.json` files one by one so the install layer
 * stays cached across source edits. The cost of that choice is a hand-written
 * list, and a hand-written list drifts: `@orbit/notifications` was added in
 * T1.15 and this file was written in T1.11, so for four tasks the image simply
 * could not be built. Nothing caught it, because nothing here is exercised by
 * `pnpm build` — only by an actual `docker build`, which happens on a deploy.
 *
 * The failure it produced was badly disguised, too. A missing manifest means
 * pnpm never links that package's dependencies, so `tsc` reports "Cannot find
 * module '@orbit/core'" from inside `packages/notifications` — pointing at an
 * import that is perfectly correct.
 *
 * This runs in the normal unit suite, so the list is checked on every commit
 * rather than on every deploy.
 */

const dockerfile = readFileSync(fileURLToPath(new URL('../Dockerfile', import.meta.url)), 'utf8');

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { dependencies: Record<string, string> };

describe('worker Dockerfile', () => {
  it('copies a manifest for every workspace package the worker depends on', () => {
    const copied = [...dockerfile.matchAll(/^COPY packages\/([a-z-]+)\/package\.json/gm)].map(
      (match) => match[1],
    );

    const required = Object.keys(manifest.dependencies)
      .filter((name) => name.startsWith('@orbit/'))
      .map((name) => name.slice('@orbit/'.length));

    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((name) => !copied.includes(name))).toEqual([]);
  });

  it('builds from the repo root, since the worker needs the workspace packages', () => {
    // A context of `apps/worker` cannot see `packages/`, and the error that
    // produces is about a missing file rather than a wrong context.
    expect(dockerfile).toContain('docker build -f apps/worker/Dockerfile');
  });

  it('bakes in the role that lets the process consume', () => {
    // `assertWorkerProcess` refuses to consume without it, so an image missing
    // this starts cleanly and does nothing at all.
    expect(dockerfile).toMatch(/^ENV ORBIT_ROLE=worker$/m);
  });
});
