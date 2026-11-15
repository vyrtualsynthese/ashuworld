import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import {
  ERASURE_PEPPER_ENV,
  PURGE_CONFIRM_ENV,
  PURGE_CONFIRM_VALUE,
  listLadder,
  withTransaction,
} from '@ashuworld/ledger'
import { runCli } from '../src/cli.js'

let db: TestDb
const savedEnv = new Map<string, string | undefined>()

const PEPPER = 'test-pepper-not-a-secret'

/** The confirmation the purge needs; a test that wants a refusal just leaves it out. */
function armPurge(): void {
  process.env[PURGE_CONFIRM_ENV] = PURGE_CONFIRM_VALUE
}

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

/** One fan by the handle it was created with, for tests that seed more than one. */
async function fanWithHandle(
  handle: string,
): Promise<{ handle: string; erased_at: Date | null } | undefined> {
  const { rows } = await db.pool.query<{ handle: string; erased_at: Date | null }>(
    'select handle, erased_at from fans where handle = $1',
    [handle],
  )
  return rows[0]
}

/**
 * One provider account that never joined an account, with a live earn so it is visible on
 * the free-standing ladder until the erasure forfeits that earn.
 */
async function seedFreeIdentity(input: {
  externalId: string
  displayHandle: string
}): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `insert into provider_identities (provider, external_id, display_handle)
     values ('twitch', $1, $2) returning id`,
    [input.externalId, input.displayHandle],
  )
  const identityId = first(rows).id
  await db.pool.query(
    `insert into xp_entries (identity_id, provider, action_key, amount, kind, idempotency_key)
     values ($1, 'twitch', 'twitch.follow', 50, 'earn', $2)`,
    [identityId, `privacy-cli-free-${input.externalId}`],
  )
  return identityId
}

/**
 * One of everything a retention pass can act on: an account untouched for over three
 * years, a never-linked identity as old, and a processed webhook from forty days ago.
 */
async function seedPurgeCandidates(): Promise<void> {
  await db.pool.query(
    `insert into fans (handle, display_name, created_at)
     values ('old', 'Old', now() - interval '1200 days')`,
  )
  await db.pool.query(
    `insert into provider_identities (provider, external_id, display_handle, created_at)
     values ('twitch', 'ext-old', 'old-ghost', now() - interval '1200 days')`,
  )
  await db.pool.query(
    `insert into inbound_events (provider, event_id, payload, received_at, processed_at)
     values ('twitch', 'evt-old', '{}'::jsonb,
             now() - interval '40 days', now() - interval '40 days')`,
  )
}

beforeAll(async () => {
  db = await createTestDb()
})

beforeEach(async () => {
  await db.reset()
  for (const key of [ERASURE_PEPPER_ENV, PURGE_CONFIRM_ENV]) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
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

  it('refuses "erase-identity" on an attached identity and changes nothing', async () => {
    await seedAccount()
    process.env[ERASURE_PEPPER_ENV] = PEPPER
    const out = capture()
    const err = capture()

    const code = await runCli(['erase-identity', 'twitch', 'ada'], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(out.lines).toEqual([])
    expect(err.lines.join('\n')).toContain('still attached')
    const { rows } = await db.pool.query<{
      external_id: string
      display_handle: string
      forensic_earns: number
    }>(
      `select i.external_id, i.display_handle,
              (select count(*)::int from xp_entries e
                where e.identity_id = i.id and e.forfeited_at is null) as forensic_earns
         from provider_identities i`,
    )
    expect(rows[0]).toMatchObject({
      external_id: 'ext-1',
      display_handle: 'ada',
      forensic_earns: 1,
    })
  })

  it('erases a never-linked identity, reports the forfeit and drops it from the ladder', async () => {
    const identityId = await seedFreeIdentity({ externalId: 'ext-ghost', displayHandle: 'ghost' })
    process.env[ERASURE_PEPPER_ENV] = PEPPER

    const before = await withTransaction(db.pool, (tx) => listLadder(tx))
    expect(before.freeStanding.map((row) => row.identityId)).toEqual([identityId])

    const out = capture()
    const err = capture()
    const code = await runCli(['erase-identity', 'twitch', 'ghost'], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(0)
    expect(err.lines).toEqual([])
    expect(out.lines.join('\n')).toContain('forfeitedEntries 1')

    const { rows } = await db.pool.query<{
      external_id: string
      display_handle: string
      live_earns: number
      forfeited_earns: number
    }>(
      `select i.external_id, i.display_handle,
              (select count(*)::int from xp_entries e
                where e.identity_id = i.id and e.forfeited_at is null) as live_earns,
              (select count(*)::int from xp_entries e
                where e.identity_id = i.id and e.forfeited_at is not null) as forfeited_earns
         from provider_identities i
        where i.id = $1`,
      [identityId],
    )
    expect(rows[0]?.external_id.startsWith('erased:')).toBe(true)
    expect(rows[0]).toMatchObject({ display_handle: 'Compte supprimé', live_earns: 0 })
    expect(rows[0]?.forfeited_earns).toBe(1)

    const after = await withTransaction(db.pool, (tx) => listLadder(tx))
    expect(after.freeStanding).toEqual([])
  })

  it('refuses "erase-identity" when two identities share a provider and handle', async () => {
    const leftId = await seedFreeIdentity({ externalId: 'ext-left', displayHandle: 'same' })
    const rightId = await seedFreeIdentity({ externalId: 'ext-right', displayHandle: 'same' })
    process.env[ERASURE_PEPPER_ENV] = PEPPER
    const err = capture()

    const code = await runCli(['erase-identity', 'twitch', 'same'], {
      pool: db.pool,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    const printed = err.lines.join('\n')
    expect(printed).toContain(leftId)
    expect(printed).toContain(rightId)
    expect(printed).toContain('ambiguous')
    // The refusal has to name a command that exists, or the operator is stuck.
    expect(printed).toContain('erase-identity-id')

    // The id it printed is the way out: one row erased, the neighbour untouched.
    const out = capture()
    const resolved = await runCli(['erase-identity-id', leftId], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: capture().write,
    })

    expect(resolved).toBe(0)
    const resolution = out.lines.join('\n')
    expect(resolution).toContain('erased true')
    expect(resolution).toContain('forfeitedEntries 1')

    const { rows } = await db.pool.query<{ external_id: string }>(
      'select external_id from provider_identities order by external_id',
    )
    const erased = rows.filter((row) => row.external_id.startsWith('erased:'))
    expect(erased).toHaveLength(1)
    // The erasure rewrites `external_id` in place, so the surviving handle still says
    // which of the two rows was left alone.
    const { rows: handles } = await db.pool.query<{ display_handle: string }>(
      'select display_handle from provider_identities',
    )
    expect(handles.map((row) => row.display_handle).sort()).toEqual([
      'Compte supprimé',
      'same',
    ])
    expect(erased[0]?.external_id.startsWith('erased:')).toBe(true)
  })

  it.each([
    ['not-a-uuid'],
    ['00000000-0000-0000-0000-00000000000'],
    ['11111111-1111-1111-1111-111111111111-extra'],
  ])('refuses "erase-identity-id" for %j without touching the database', async (bad) => {
    const connect = vi.fn()
    const query = vi.fn()
    const err = capture()

    const code = await runCli(['erase-identity-id', bad], {
      pool: { connect, query } as unknown as Pool,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(connect).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(err.lines.join('\n')).toContain('is not an identity id')
  })

  it('refuses "erase-identity-id" on an attached identity and changes nothing', async () => {
    await seedAccount()
    process.env[ERASURE_PEPPER_ENV] = PEPPER
    const { rows: seeded } = await db.pool.query<{ id: string }>(
      'select id from provider_identities',
    )
    const attachedId = first(seeded).id
    const out = capture()
    const err = capture()

    const code = await runCli(['erase-identity-id', attachedId], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(out.lines).toEqual([])
    expect(err.lines.join('\n')).toContain('still attached')
    const { rows } = await db.pool.query<{ external_id: string; display_handle: string }>(
      'select external_id, display_handle from provider_identities',
    )
    expect(rows[0]).toMatchObject({ external_id: 'ext-1', display_handle: 'ada' })
  })

  it.each([
    ['erase-identity', 'twitch', 'ghost'],
    ['purge'],
  ])('refuses %j without ERASURE_PEPPER and changes nothing', async (...args: string[]) => {
    // The purge row is armed first, so it reaches the pepper rather than the confirmation
    // and the assertion below is about the variable it claims to be about.
    armPurge()
    const connect = vi.fn()
    const query = vi.fn()
    const err = capture()

    const code = await runCli(args, {
      pool: { connect, query } as unknown as Pool,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(connect).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(err.lines.join('\n')).toContain(ERASURE_PEPPER_ENV)
  })

  it('refuses "erase-identity" for an unknown provider before touching the database', async () => {
    const connect = vi.fn()
    const query = vi.fn()
    const err = capture()

    const code = await runCli(['erase-identity', 'myspace', 'ghost'], {
      pool: { connect, query } as unknown as Pool,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(connect).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(err.lines.join('\n')).toContain('myspace')
  })

  it('refuses "erase-identity" for a provider and handle that match nothing', async () => {
    process.env[ERASURE_PEPPER_ENV] = PEPPER
    const err = capture()

    const code = await runCli(['erase-identity', 'twitch', 'nobody'], {
      pool: db.pool,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(err.lines.join('\n')).toContain('no identity matches that provider and handle')
  })

  it('previews the retention pass on "purge --dry-run" and writes nothing', async () => {
    await seedAccount()
    await seedPurgeCandidates()
    process.env[ERASURE_PEPPER_ENV] = PEPPER
    armPurge()
    const out = capture()
    const err = capture()

    const code = await runCli(['purge', '--dry-run'], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(0)
    expect(err.lines).toEqual([])
    const printed = out.lines.join('\n')
    expect(printed).toContain('fans 1')
    expect(printed).toContain('identities 1')
    expect(printed).toContain('events 1')

    const fan = await fanWithHandle('old')
    expect(fan).toMatchObject({ handle: 'old', erased_at: null })
    const { rows: identities } = await db.pool.query<{ external_id: string }>(
      `select external_id from provider_identities order by external_id`,
    )
    expect(identities.map((row) => row.external_id)).toEqual(['ext-1', 'ext-old'])
    const { rows: events } = await db.pool.query<{ n: number }>(
      'select count(*)::int as n from inbound_events',
    )
    expect(first(events).n).toBe(1)
  })

  it('refuses "purge" without PURGE_CONFIRM and changes nothing', async () => {
    await seedPurgeCandidates()
    process.env[ERASURE_PEPPER_ENV] = PEPPER
    const err = capture()

    const code = await runCli(['purge'], {
      pool: db.pool,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(err.lines.join('\n')).toContain(PURGE_CONFIRM_ENV)
    expect(await fanRow()).toMatchObject({ handle: 'old', erased_at: null })
  })

  it('refuses "purge" when PURGE_CONFIRM is blank or wrong', async () => {
    await seedPurgeCandidates()
    process.env[ERASURE_PEPPER_ENV] = PEPPER
    for (const wrong of ['   ', 'PURGE-ASHUWORLD']) {
      process.env[PURGE_CONFIRM_ENV] = wrong
      const err = capture()
      const code = await runCli(['purge'], {
        pool: db.pool,
        processors: new Map(),
        out: capture().write,
        err: err.write,
      })
      expect(code).toBe(1)
      expect(err.lines.join('\n')).toContain(PURGE_CONFIRM_ENV)
    }
    expect(await fanRow()).toMatchObject({ handle: 'old', erased_at: null })
  })

  it('purges an inactive account and a stale identity, then reports zeros on a second run', async () => {
    await seedPurgeCandidates()
    process.env[ERASURE_PEPPER_ENV] = PEPPER
    armPurge()

    const out = capture()
    const err = capture()
    const code = await runCli(['purge'], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(0)
    expect(err.lines).toEqual([])
    expect(out.lines.join('\n')).toContain('fans 1, identities 1')

    const fan = await fanRow()
    expect(fan?.handle.startsWith('deleted_')).toBe(true)
    expect(fan?.erased_at).not.toBeNull()
    const { rows: identities } = await db.pool.query<{ external_id: string }>(
      'select external_id from provider_identities',
    )
    expect(identities[0]?.external_id.startsWith('erased:')).toBe(true)
    const { rows: events } = await db.pool.query<{ n: number }>(
      'select count(*)::int as n from inbound_events',
    )
    expect(first(events).n).toBe(0)

    const secondOut = capture()
    const second = await runCli(['purge'], {
      pool: db.pool,
      processors: new Map(),
      out: secondOut.write,
      err: capture().write,
    })
    expect(second).toBe(0)
    expect(secondOut.lines.join('\n')).toContain('fans 0, identities 0')
  })

  it.each([
    ['export-fan'],
    ['export-fan', 'ada', 'extra'],
    ['erase-fan'],
    ['erase-fan', 'ada', 'extra'],
    ['erase-identity'],
    ['erase-identity', 'twitch'],
    ['erase-identity', 'twitch', 'ada', 'extra'],
    ['erase-identity-id'],
    ['erase-identity-id', 'abc', 'extra'],
    ['purge', '--force'],
    ['purge', '--dry-run', 'extra'],
  ])('refuses %j without touching the database', async (...args: string[]) => {
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
  })
})
