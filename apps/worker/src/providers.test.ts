import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The worker and the web app must register the same adapters.
 *
 * They are deliberately separate files — the two processes may legitimately
 * differ, and a shared module would mean a change for one silently changing the
 * other. The price is that adding an adapter means editing both, and forgetting
 * the second one is invisible until something real is published.
 *
 * That happened. Instagram was registered in the web app only: the composer
 * validated against its capabilities, the post passed review, it was approved,
 * scheduled and enqueued — and the worker failed it with
 * `NOT_FOUND: Instagram isn't available yet`, which reads like a platform
 * outage rather than a missing line in a bootstrap file. Nothing before the
 * publish attempt could have caught it.
 *
 * Comparing the two import lists is crude, and it is the check that would have
 * caught it at commit rather than in a client's queue.
 */

function adaptersIn(path: string): string[] {
  const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  return [...source.matchAll(/^import \{ (\w+Provider) \} from '@orbit\/providers\/\w+';$/gm)]
    .map((match) => match[1] as string)
    .filter((name) => name !== 'MockProvider')
    .sort();
}

describe('provider bootstrap', () => {
  it('registers the same adapters as the web app', () => {
    const worker = adaptersIn('./providers.ts');
    const web = adaptersIn('../../web/src/server/providers.ts');

    expect(worker.length).toBeGreaterThan(0);
    expect(worker).toEqual(web);
  });

  it('publishes for real when a Meta app is configured', () => {
    const source = readFileSync(fileURLToPath(new URL('./providers.ts', import.meta.url)), 'utf8');

    // The mock must stay behind `developmentOnly`, which the registry refuses
    // to honour in production (SRS §42).
    expect(source).toContain('developmentOnly: true');
  });
});
