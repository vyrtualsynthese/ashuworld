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
