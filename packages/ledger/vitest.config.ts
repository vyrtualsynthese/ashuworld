import { defineConfig } from 'vitest/config'

// Do not throw when this is missing: the workspace loads every package's config before
// --project filters them, so throwing here would break `pnpm --filter
// @ashuworld/providers test` on a machine with no database. The ledger helper fails with
// the readable message instead, and only when a ledger test actually needs a database.
const databaseUrl = process.env['TEST_DATABASE_URL']

export default defineConfig({
  test: {
    // process.chdir() is only legal outside worker threads, and the migration
    // path-resolution test uses it.
    pool: 'forks',
    // Pass the URL through to the workers so the helper reads exactly what this config saw.
    env: databaseUrl === undefined ? {} : { TEST_DATABASE_URL: databaseUrl },
  },
})
