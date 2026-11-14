/**
 * The throwaway-schema harness every package's integration tests share.
 *
 * It lives outside `src/` on purpose: the coverage report measures `packages/<name>/src`
 * only, so a test-only module here is not counted as untested production code, and apps
 * cannot import it by accident through the package's root entry point. Import
 * `@ashuworld/ledger/testing`.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import type { Pool } from 'pg'
import { attachIdleErrorHandler, withTransaction } from '../src/db.js'
import { migrate } from '../src/migrate.js'

export interface TestDb {
  /** Every connection in this pool sees the throwaway schema first. */
  pool: Pool
  /** Empties every table in the schema; the migration record stays so tests are not re-migrated. */
  reset(): Promise<void>
  /** Drops the throwaway schema. `pool.end()` does this too, so a forgotten teardown is harmless. */
  drop(): Promise<void>
}

function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL']
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'TEST_DATABASE_URL is not set. The integration tests run against a real Postgres 17, so export it before starting vitest: TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu',
    )
  }
  return url
}

/**
 * pgcrypto is a database-level extension: installing it with the migration's
 * `create extension if not exists pgcrypto` inside a throwaway schema would put it in
 * that schema and drop `gen_random_uuid()` along with it. Install it once in `public`,
 * under the same advisory lock the migrator uses, so parallel test files cannot race the
 * extension catalogue; the migration's line then stays a no-op, exactly as written.
 */
async function installPgcrypto(pool: Pool): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', ['ashuworld_test_bootstrap'])
    await tx.query('create extension if not exists pgcrypto with schema public')
  })
}

/**
 * A database for one test file: a fresh, uniquely named schema on the shared test
 * database, migrated before it is returned. The unique name means a crashed run leaves
 * a schema behind that nobody will touch, rather than poisoning the next run.
 */
export async function createTestDb(options: { migrate?: boolean } = {}): Promise<TestDb> {
  const schema = `test_${randomUUID().replaceAll('-', '')}`
  // search_path is a connection startup option, so every client the pool hands out is
  // already scoped to the schema; no per-query SET can be forgotten or lost on reconnect.
  const pool = new pg.Pool({
    connectionString: testDatabaseUrl(),
    options: `-c search_path=${schema},public`,
  })
  attachIdleErrorHandler(pool)

  await installPgcrypto(pool)
  await pool.query(`create schema "${schema}"`)

  if (options.migrate ?? true) {
    await migrate(pool)
  }

  let dropped = false

  async function drop(): Promise<void> {
    if (dropped) return
    dropped = true
    await pool.query(`drop schema if exists "${schema}" cascade`)
  }

  async function reset(): Promise<void> {
    // The schema name from the closure, not current_schema(): if the throwaway schema
    // ever left the search path, current_schema() would be public and this would
    // truncate a developer's real tables.
    const { rows } = await pool.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = $1 and tablename <> '_migrations'`,
      [schema],
    )
    if (rows.length === 0) return
    const tables = rows.map((row) => `"${row.tablename}"`).join(', ')
    await pool.query(`truncate table ${tables} restart identity cascade`)
  }

  // The brief's teardown is `await db.pool.end()`, so hook the drop there: a test file
  // that never calls drop() still leaves nothing behind. A failed drop must not turn a
  // passing test red, hence the catch.
  const endPool = pool.end.bind(pool)
  pool.end = async () => {
    await drop().catch(() => undefined)
    await endPool()
  }

  return { pool, reset, drop }
}
