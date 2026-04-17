import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    exclude: ['test/vscode-host/**', 'node_modules/**', 'dist/**'],
    // The adapter E2E launches Chrome + Vite serially within a single suite;
    // run files sequentially so ports and Chrome instances don't collide.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Each test file can own its own Vite/Chrome pair, so isolate across files.
    isolate: true,
  },
});
