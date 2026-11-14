import type { Pool } from 'pg'
import { createPool, migrate, migrationFiles } from '@ashuworld/ledger'

/**
 * The entry point the Kubernetes migrate Job runs (`node dist/migrate.js`).
 *
 * `migrationFiles()` resolves the `.sql` files from `../migrations/` relative to this
 * module, so it finds them only if the directory ships next to the bundle. The image puts
 * both at `/app/dist/migrate.js` and `/app/migrations`, and this file logs the names it
 * found: that line is the smoke test's proof the image is built correctly, and the
 * reason a broken image fails before the api deploys rather than on its first query.
 *
 * Nothing here is retried in a loop. A failed migration stops the Job, the pre-upgrade
 * hook holds the release back, and the operator reads the error with the migration name
 * in it. A retry loop would only hide the second half of a partially applied migration.
 */

/** `DATABASE_URL`, or a message naming it. Empty is missing. */
function databaseUrl(raw: NodeJS.ProcessEnv = process.env): string {
  const url = raw['DATABASE_URL']
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'DATABASE_URL is required but was not set; export it before running the migrations',
    )
  }
  return url.trim()
}

/** Postgres's `undefined_table`. The first run has no `_migrations` table yet. */
const UNDEFINED_TABLE = '42P01'

/**
 * The number of migrations recorded so far, or 0 before the bookkeeping table exists.
 *
 * Only `undefined_table` is treated as "nothing applied": any other failure (a refused
 * connection, a permissions problem) is a real error and must not be reported as clean.
 */
async function appliedCount(pool: Pool): Promise<number> {
  try {
    const { rows } = await pool.query<{ count: string }>(
      'select count(*)::text as count from _migrations',
    )
    return Number(rows[0]?.count ?? 0)
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === UNDEFINED_TABLE) return 0
    throw error
  }
}

/**
 * Applies the migrations and reports what this run did.
 *
 * The count is the difference around `migrate` rather than something `migrate` returns:
 * the ledger entry point stays the same for the tests and the Job, and the Job is the
 * only caller that wants a number for the log. `after` is also checked against the files
 * on disk, so a directory that lost one to a bad build is visible in the Job log instead
 * of silently skipped.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const files = migrationFiles()
  if (files.length === 0) {
    throw new Error('no .sql migration files were found next to the migrate entry point')
  }
  console.log(`[migrate] ${files.length} migration file(s) found: ${files.join(', ')}`)

  const before = await appliedCount(pool)
  await migrate(pool)
  const after = await appliedCount(pool)

  if (after < files.length) {
    throw new Error(
      `${after} migrations are recorded but ${files.length} files were found; ` +
        'the directory and the database disagree',
    )
  }
  console.log(
    `[migrate] applied ${after - before} migration(s); ${after} of ${files.length} file(s) are recorded`,
  )
}

async function main(): Promise<void> {
  const pool = createPool(databaseUrl())
  try {
    await runMigrations(pool)
  } finally {
    await pool.end()
  }
}

try {
  await main()
} catch (error) {
  console.error(
    `[migrate] the migrations did not finish: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
}
