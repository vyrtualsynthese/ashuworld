import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { createPool, withTransaction, type Queryable } from '../src/index.js'
import { createTestDb, type TestDb } from './helpers/db.js'

function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL']
  if (url === undefined) throw new Error('TEST_DATABASE_URL is not set')
  return url
}

describe('createPool', () => {
  it('opens a usable pool and closes it', async () => {
    const pool = createPool(testDatabaseUrl())
    try {
      const { rows } = await pool.query<{ one: number }>('select 1 as one')
      expect(rows[0]?.one).toBe(1)
    } finally {
      await pool.end()
    }
  })
})

describe('withTransaction', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  })

  beforeEach(async () => {
    await db.reset()
  })

  afterAll(async () => {
    await db.pool.end()
  })

  async function insertFan(tx: Queryable, handle: string) {
    await tx.query(`insert into fans (handle, display_name) values ($1, $2)`, [handle, handle])
  }

  async function fanHandles(): Promise<string[]> {
    const { rows } = await db.pool.query<{ handle: string }>('select handle from fans order by handle')
    return rows.map((row) => row.handle)
  }

  it('commits when the function resolves', async () => {
    await withTransaction(db.pool, async (tx) => {
      await insertFan(tx, 'ashu')
    })
    expect(await fanHandles()).toEqual(['ashu'])
  })

  it('returns the value the function produced', async () => {
    const value = await withTransaction(db.pool, async (tx) => {
      await insertFan(tx, 'ashu')
      const { rows } = await tx.query<{ n: number }>('select count(*)::int as n from fans')
      return rows[0]?.n
    })
    expect(value).toBe(1)
  })

  it('rolls back and rethrows when the function throws', async () => {
    await expect(
      withTransaction(db.pool, async (tx) => {
        await insertFan(tx, 'ashu')
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await fanHandles()).toEqual([])
  })

  it('rolls back the earlier statements when a statement fails', async () => {
    await expect(
      withTransaction(db.pool, async (tx) => {
        await insertFan(tx, 'ashu')
        // Same handle again: the unique constraint aborts the transaction.
        await insertFan(tx, 'ashu')
      }),
    ).rejects.toThrow(/fans_handle_key/)
    expect(await fanHandles()).toEqual([])
  })

  it('hands every connection back, so the next transaction is not blocked', async () => {
    await withTransaction(db.pool, async (tx) => {
      await tx.query('select 1')
    })
    await withTransaction(db.pool, async (tx) => {
      await tx.query('select 1')
    })
    expect(db.pool.idleCount).toBe(db.pool.totalCount)
    expect(db.pool.waitingCount).toBe(0)
  })

  it('does not leak a transaction that failed into the next one', async () => {
    await expect(
      withTransaction(db.pool, async (tx) => {
        await tx.query('select * from does_not_exist')
      }),
    ).rejects.toThrow()

    const value = await withTransaction(db.pool, async (tx) => {
      const { rows } = await tx.query<{ one: number }>('select 1 as one')
      return rows[0]?.one
    })
    expect(value).toBe(1)
  })

  it('destroys the connection when the rollback itself fails', async () => {
    // A real connection cannot be made to fail its rollback on demand, so this is the
    // one place a stub stands in for pg: it proves a broken connection is never handed
    // back to the pool in an unknown transaction state.
    const released: Array<boolean> = []
    const client = {
      query: async (text: string) => {
        if (text === 'rollback') throw new Error('connection lost')
        return { rows: [] }
      },
      release: (broken?: boolean) => {
        released.push(broken === true)
      },
    }
    const pool = { connect: async () => client } as unknown as Pool

    await expect(
      withTransaction(pool, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(released).toEqual([true])
  })
})

describe('reset', () => {
  it('empties the tables and keeps the migration record', async () => {
    const db = await createTestDb()
    try {
      await db.pool.query(`insert into fans (handle, display_name) values ('ashu', 'Ashu')`)
      await db.reset()
      const { rows } = await db.pool.query<{ n: string }>('select count(*)::text as n from fans')
      expect(rows[0]?.n).toBe('0')
      const { rows: applied } = await db.pool.query<{ n: string }>('select count(*)::text as n from _migrations')
      expect(applied[0]?.n).toBe('1')
    } finally {
      await db.pool.end()
    }
  })
})
