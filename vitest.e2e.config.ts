import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * End-to-end tests (SRS §32, T1.19).
 *
 * A third project alongside unit and integration, and separate for a reason
 * that is not just speed: these run the **whole product as one path** —
 * connect, compose, approve, schedule, publish, log, portal — against real
 * Postgres, real Redis, real S3 and the mock provider. When one fails it is
 * usually the seam between two features rather than either feature, and mixing
 * them into the integration run would blur that signal.
 *
 * Requires `pnpm infra:up` and applied migrations, like the integration suite.
 * Strictly sequential: the flow is a narrative, and steps depend on each other.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    // Inside `apps/web` so `next/server` resolves — the flow drives real route
    // handlers, and Next is that app's dependency rather than the root's.
    include: ['apps/web/e2e/**/*.e2e.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globals: false,
    fileParallelism: false,
    // A full flow touches every subsystem; the publish step alone waits on a
    // lock, a rate-limit bucket and a provider call.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Steps build on each other, so a failure part-way through makes the rest
    // noise rather than information.
    bail: 1,
  },
});
