import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import { ERASURE_PEPPER_ENV, listLadder, withTransaction } from '@ashuworld/ledger'
import { runCli } from '../src/cli.js'

let db: TestDb
const savedEnv = new Map<string, string | undefined>()

const PEPPER = 'test-pepper-not-a-secret'

function first<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('expected at least one row')
  return row
}

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line) }
}

/** One active account with a linked identity and a live earn, so both commands have work. */
async function seedAccount(): Promise<void> {
  const { rows } = await db.pool.query<{ id: string }>(
    `insert into fans (handle, display_name, peak_xp, level)
     values ('ada', 'Ada', 50, 1) returning id`,
  )
  const fanId = first(rows).id
  const { rows: identities } = await db.pool.query<{ id: string }>(
    `insert into provider_identities
       (provider, external_id, display_handle, fan_id, linked_at, first_linked_at)
     values ('twitch', 'ext-1', 'ada', $1, now(), now()) returning id`,
    [fanId],
  )
  await db.pool.query(
    `insert into xp_entries (identity_id, provider, action_key, amount, kind, idempotency_key)
     values ($1, 'twitch', 'twitch.follow', 50, 'earn', 'privacy-cli-earn-1')`,
    [first(identities).id],
  )
}

async function fanRow(): Promise<{ handle: string; erased_at: Date | null } | undefined> {
  const { rows } = await db.pool.query<{ handle: string; erased_at: Date | null }>(
    'select handle, erased_at from fans',
  )
  return rows[0]
}

beforeAll(async () => {
  db = await createTestDb()
})

beforeEach(async () => {
  await db.reset()
  savedEnv.set(ERASURE_PEPPER_ENV, process.env[ERASURE_PEPPER_ENV])
  delete process.env[ERASURE_PEPPER_ENV]
})

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
})

afterAll(async () => {
  await db.pool.end()
})

describe('runCli privacy commands', () => {
  it('prints one JSON document for an active handle on "export-fan"', async () => {
    await seedAccount()
    const out = capture()
    const err = capture()

    const code = await runCli(['export-fan', 'ada'], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(0)
    expect(err.lines).toEqual([])
    const document = JSON.parse(out.lines.join('\n')) as {
      handle: string
      identities: unknown[]
      entries: unknown[]
    }
    expect(document.handle).toBe('ada')
    expect(document.identities).toHaveLength(1)
    expect(document.entries).toHaveLength(1)
  })

  it('normalises the exported handle, so a typed "Ada" still finds the account', async () => {
    await seedAccount()
    const out = capture()

    const code = await runCli(['export-fan', ' Ada '], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: capture().write,
    })

    expect(code).toBe(0)
    expect(JSON.parse(out.lines.join('\n'))).toMatchObject({ handle: 'ada' })
  })

  it('exits non-zero and prints no document for an unknown handle on "export-fan"', async () => {
    const out = capture()
    const err = capture()

    const code = await runCli(['export-fan', 'nobody'], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(out.lines).toEqual([])
    expect(err.lines.join('\n')).toContain('no active account has that handle')
  })

  it('refuses "erase-fan" without ERASURE_PEPPER and changes nothing', async () => {
    await seedAccount()
    const err = capture()

    const code = await runCli(['erase-fan', 'ada'], {
      pool: db.pool,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(err.lines.join('\n')).toContain(ERASURE_PEPPER_ENV)
    expect(await fanRow()).toMatchObject({ handle: 'ada', erased_at: null })
    const { rows } = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from xp_entries where forfeited_at is null`,
    )
    expect(first(rows).n).toBe(1)
  })

  it('erases the account with ERASURE_PEPPER, prints the counts and drops it from the ladder', async () => {
    await seedAccount()
    process.env[ERASURE_PEPPER_ENV] = PEPPER
    const out = capture()
    const err = capture()

    const code = await runCli(['erase-fan', 'ada'], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(0)
    expect(err.lines).toEqual([])
    const printed = out.lines.join('\n')
    expect(printed).toContain('identities 1')
    expect(printed).toContain('forfeitedEntries 1')
    expect(printed).toContain('the account is erased')

    const fan = await fanRow()
    expect(fan?.handle.startsWith('deleted_')).toBe(true)
    expect(fan?.erased_at).not.toBeNull()

    const ladder = await withTransaction(db.pool, (tx) => listLadder(tx))
    expect(ladder.linked).toEqual([])
    expect(ladder.freeStanding).toEqual([])
  })

  it('treats a second "erase-fan" on the same handle as an unknown account', async () => {
    await seedAccount()
    process.env[ERASURE_PEPPER_ENV] = PEPPER
    const firstRun = await runCli(['erase-fan', 'ada'], {
      pool: db.pool,
      processors: new Map(),
      out: capture().write,
      err: capture().write,
    })
    expect(firstRun).toBe(0)

    const out = capture()
    const err = capture()
    const code = await runCli(['erase-fan', 'ada'], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(out.lines).toEqual([])
    expect(err.lines.join('\n')).toContain('no active account has that handle')
  })

  it.each([['export-fan'], ['export-fan', 'ada', 'extra'], ['erase-fan'], ['erase-fan', 'ada', 'extra']])(
    'refuses %j without touching the database',
    async (...args: string[]) => {
      const connect = vi.fn()
      const query = vi.fn()
      const untouched = { connect, query } as unknown as Pool
      const err = capture()

      const code = await runCli(args, {
        pool: untouched,
        processors: new Map(),
        out: capture().write,
        err: err.write,
      })

      expect(code).toBe(1)
      expect(connect).not.toHaveBeenCalled()
      expect(query).not.toHaveBeenCalled()
      expect(err.lines.join('\n')).toContain(args[0] as string)
    },
  )
})
