import { defineConfig } from 'vitest/config'

const databaseUrl = process.env['TEST_DATABASE_URL']

if (databaseUrl === undefined || databaseUrl.trim() === '') {
  throw new Error(
    'TEST_DATABASE_URL is not set. The ledger tests run against a real Postgres 17, so export it before starting vitest: TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu',
  )
}

export default defineConfig({
  test: {
    // Pass the URL through to the workers so the helper reads exactly what this config checked.
    env: { TEST_DATABASE_URL: databaseUrl },
  },
})
