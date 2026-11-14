import pg from 'pg'
import type { Pool } from 'pg'

/**
 * The surface every query goes through: a pool, or the open transaction passed to
 * `withTransaction`. Ledger functions take a `Queryable` so they compose inside a
 * transaction without ever knowing whether they were given a connection.
 */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>
}

export function createPool(url: string): Pool {
  const pool = new pg.Pool({ connectionString: url })
  attachIdleErrorHandler(pool)
  return pool
}

/**
 * An idle client that dies (Postgres restart, a terminated backend, a network blip)
 * makes the pool emit `error`. Without a listener Node treats it as unhandled and kills
 * the process, so every pool this module creates logs and carries on; the next query
 * gets a fresh connection.
 */
export function attachIdleErrorHandler(pool: Pool): void {
  pool.on('error', (error) => {
    console.error('[ledger] idle postgres client failed; the pool will replace it', error)
  })
}

function asQueryable(client: pg.PoolClient): Queryable {
  return {
    async query<R extends object = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }> {
      const result = await client.query(text, values as unknown[] | undefined)
      return { rows: result.rows as R[] }
    },
  }
}

/**
 * True when Postgres refused the write because the unique constraint `constraint` already
 * holds that key. The constraint name is part of the test on purpose: `23505` alone also
 * covers every other unique index on the table, and a caller that treated those as "this
 * key is taken" would report the wrong reason without ever failing.
 *
 * The error is read structurally rather than imported from `pg`: the ledger's `Queryable`
 * is not necessarily a pg client, and only these two fields matter.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, constraint: refused } = error as { code?: unknown; constraint?: unknown }
  return code === '23505' && refused === constraint
}

/**
 * Runs `fn` inside `begin`/`commit`, rolling back if it throws and always returning the
 * connection to the pool. A connection whose rollback fails is destroyed instead of
 * being handed to the next caller in an unknown transaction state.
 */
export async function withTransaction<T>(pool: Pool, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('begin')
    const value = await fn(asQueryable(client))
    await client.query('commit')
    return value
  } catch (error) {
    try {
      await client.query('rollback')
    } catch {
      broken = true
    }
    throw error
  } finally {
    client.release(broken)
  }
}
