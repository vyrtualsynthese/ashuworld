import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { withTransaction } from './db.js'

/**
 * Resolved from this module, never from `process.cwd()`: the runner is called from
 * vitest (rooted at the repo root) and from the Kubernetes Job (rooted at the image's
 * working directory). `migrations/` must therefore ship next to the built entry point.
 */
const MIGRATIONS_URL = new URL('../migrations/', import.meta.url)

/** The migration files, in the order they run. */
export function migrationFiles(): string[] {
  let entries: string[]
  try {
    entries = readdirSync(MIGRATIONS_URL)
  } catch (error) {
    throw new Error(`migrations directory not found at ${fileURLToPath(MIGRATIONS_URL)}`, { cause: error })
  }
  return entries.filter((name) => name.endsWith('.sql')).sort()
}

/**
 * Creates the bookkeeping table.
 *
 * `create table if not exists` is not race-free in Postgres: two sessions can both see
 * the table missing and one loses on the catalogue's unique index. If the table exists
 * once the error surfaces, the other runner created it and this one carries on.
 */
async function ensureMigrationsTable(pool: Pool): Promise<void> {
  try {
    await pool.query(`
      create table if not exists _migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `)
  } catch (error) {
    const { rows } = await pool.query<{ present: boolean }>(
      `select to_regclass('_migrations') is not null as present`,
    )
    if (rows[0]?.present !== true) throw error
  }
}

/**
 * Applies every migration not yet recorded in `_migrations`, one transaction per file.
 *
 * Idempotent and safe to run from two processes at once: the advisory transaction lock
 * serialises them, and the recorded-name check happens again inside the lock so the
 * loser of the race skips the file instead of replaying it.
 */
export async function migrate(pool: Pool): Promise<void> {
  await ensureMigrationsTable(pool)

  const { rows } = await pool.query<{ name: string }>('select name from _migrations')
  const applied = new Set(rows.map((row) => row.name))

  for (const name of migrationFiles()) {
    if (applied.has(name)) continue
    await withTransaction(pool, async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtext('ashuworld_migrations'))`)
      const { rows: seen } = await tx.query<{ present: boolean }>(
        'select exists (select 1 from _migrations where name = $1) as present',
        [name],
      )
      if (seen[0]?.present === true) return
      await tx.query(readFileSync(new URL(name, MIGRATIONS_URL), 'utf8'))
      await tx.query('insert into _migrations (name) values ($1)', [name])
    })
  }
}
