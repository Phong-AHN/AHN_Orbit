import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the `@/*` path alias in apps/web/tsconfig.json.
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    // Unit tests must run with no infrastructure (no Postgres, no Redis, no network).
    // The other two projects are opt-in once `pnpm infra:up` is running:
    // `pnpm test:integration` and `pnpm test:e2e`. Both are excluded here by
    // suffix — `*.e2e.test.ts` also matches `*.test.ts`, so leaving it out is
    // what stops the E2E flow being dragged into the infrastructure-free run.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts', '**/*.e2e.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/types.ts'],
    },
  },
});
