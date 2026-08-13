import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests. Require `pnpm infra:up` (Postgres + Redis + MinIO) and an
 * applied migration set. Kept out of the default `pnpm test` run so unit tests
 * stay infrastructure-free and fast.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `@/*` path alias in apps/web/tsconfig.json.
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.integration.test.ts', 'apps/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.e2e.test.ts'],
    environment: 'node',
    globals: false,
    // Integration tests share one database; running them in parallel would
    // have them stepping on each other's rows.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
