import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

// One root config rather than per-workspace projects: every package tests pure
// TypeScript in a node environment, and the handful of component tests opt into
// jsdom with a `@vitest-environment jsdom` docblock. Keeps coverage thresholds
// and aliases defined in exactly one place.
//
// Aliases point at source, not dist, so `npm test` never depends on a prior
// build. `npm run typecheck` is what validates the built project references.
export default defineConfig({
  test: {
    include: ['{packages,apps}/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['{packages,apps}/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/fixtures/**', '**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@lopie/shared': src('shared'),
      '@lopie/yahoo-client': src('yahoo-client'),
      '@lopie/challenge-engine': src('challenge-engine'),
      '@lopie/draft-order': src('draft-order'),
      '@lopie/csv-import': src('csv-import'),
    },
  },
});
