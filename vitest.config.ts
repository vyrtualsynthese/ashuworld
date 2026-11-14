import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // One project per workspace package. This replaces `vitest.workspace.ts`, which Vitest 4
    // removed; the globs are resolved from the repository root, so a package's own test script
    // runs through that root (`--root ../.. --project <name>`) rather than from inside itself.
    projects: ['apps/*', 'packages/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/dist/**', '**/test/**', '**/*.d.ts', '**/*.config.ts'],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
})
