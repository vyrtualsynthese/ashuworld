import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import { ALPHA_RESET_CONFIRM_ENV, ALPHA_RESET_CONFIRM_VALUE } from '@ashuworld/ledger'
import { runCli } from '../src/cli.js'
import { createStubConnector } from '../src/connectors/stub.js'
import type { ProcessorMap } from '../src/processors.js'

let db: TestDb
const savedEnv = new Map<string, string | undefined>()
const CONFIG_VERSION_ENV = 'GAME_CONFIG_VERSION'

function first<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('expected at least one row')
  return row
}

function capture(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = []
  return { lines, write: (line) => lines.push(line) }
}

async function countRows(table: string, where = ''): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>(
    `select count(*)::int as n from ${table} ${where}`,
  )
  return first(rows).n
}

/** One fan with XP on the books, so a reset has something to report and something to zero. */
async function seedXp(): Promise<void> {
  const { rows } = await db.pool.query<{ id: string }>(
    `insert into fans (handle, display_name, peak_xp, level)
     values ('ada', 'ada', 120, 3) returning id`,
  )
  const fanId = first(rows).id
  const { rows: identities } = await db.pool.query<{ id: string }>(
    `insert into provider_identities (provider, external_id, display_handle, fan_id)
     values ('twitch', 'ext-1', 'ada', $1) returning id`,
    [fanId],
  )
  await db.pool.query(
    `insert into xp_entries (identity_id, provider, action_key, amount, kind, idempotency_key)
     values ($1, 'twitch', 'twitch.follow', 50, 'earn', 'cli-earn-1')`,
    [first(identities).id],
  )
}

beforeAll(async () => {
  db = await createTestDb()
})

beforeEach(async () => {
  await db.reset()
  for (const key of [ALPHA_RESET_CONFIRM_ENV, CONFIG_VERSION_ENV]) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  // The ledger's reset logs its config version; these tests assert on the CLI's output.
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
})

afterAll(async () => {
  await db.pool.end()
})

describe('runCli', () => {
  it('runs the reset on "reset" and prints the counts and the config version', async () => {
    await seedXp()
    process.env[ALPHA_RESET_CONFIRM_ENV] = ALPHA_RESET_CONFIRM_VALUE
    process.env[CONFIG_VERSION_ENV] = '2026-11-14.1'
    const out = capture()
    const err = capture()

    const code = await runCli(['reset'], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(0)
    expect(err.lines).toEqual([])
    const printed = out.lines.join('\n')
    expect(printed).toContain('xp_entries 1')
    expect(printed).toContain('provider_identities 1')
    expect(printed).toContain('sessions 0')
    expect(printed).toContain('2026-11-14.1')

    expect(await countRows('xp_entries')).toBe(0)
    const { rows } = await db.pool.query<{ peak_xp: number; level: number }>(
      'select peak_xp, level from fans',
    )
    expect(rows).toEqual([{ peak_xp: 0, level: 0 }])
  })

  it('drains the queue when given no argument', async () => {
    await db.pool.query(
      `insert into inbound_events (provider, event_id, payload)
       values ('twitch', 'follow-1', '{}')`,
    )
    const controller = new AbortController()
    const processors: ProcessorMap = new Map([
      [
        'twitch',
        async (tx) => {
          await tx.query(`insert into audit_log (kind) values ('test.cli-loop')`)
          // The loop checks the signal between polls, so the event in flight finishes
          // and commits, then the process returns.
          controller.abort()
        },
      ],
    ])
    const out = capture()
    const err = capture()

    const code = await runCli([], {
      pool: db.pool,
      processors,
      signal: controller.signal,
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(0)
    expect(err.lines).toEqual([])
    expect(await countRows('audit_log', `where kind = 'test.cli-loop'`)).toBe(1)
  })

  it('runs discovery beside the queue, and an aborted signal stops both without queuing', async () => {
    const code = await runCli([], {
      pool: db.pool,
      processors: new Map(),
      connectors: [createStubConnector(2)],
      syncIntervalMs: 1,
      signal: AbortSignal.abort(),
      out: capture().write,
      err: capture().write,
    })

    expect(code).toBe(0)
    // The runner stops before its first round, so the stub never reaches the queue.
    expect(await countRows('inbound_events')).toBe(0)
  })

  it('rejects an unknown argument without touching the database', async () => {
    const connect = vi.fn()
    const query = vi.fn()
    const untouched = { connect, query } as unknown as Pool
    const err = capture()

    const code = await runCli(['truncate'], {
      pool: untouched,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(err.lines.join('\n')).toContain('truncate')
    expect(connect).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects extra arguments after "reset" so a stray flag cannot arm anything', async () => {
    const connect = vi.fn()
    const untouched = { connect, query: vi.fn() } as unknown as Pool
    const err = capture()

    const code = await runCli(['reset', '--force'], {
      pool: untouched,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(err.lines.join('\n')).toContain('reset')
    expect(connect).not.toHaveBeenCalled()
  })

  it('raises levels from the game config on "recompute-levels" and reports the version', async () => {
    await db.pool.query(
      `insert into fans (handle, display_name, peak_xp, level)
       values ('ada', 'ada', 800, 0), ('ben', 'ben', 50, 0)`,
    )
    const out = capture()
    const err = capture()

    const code = await runCli(['recompute-levels'], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: err.write,
    })

    expect(code).toBe(0)
    expect(err.lines).toEqual([])
    const printed = out.lines.join('\n')
    expect(printed).toContain('scanned 2 fans')
    expect(printed).toContain('raised 1 levels')
    // The version comes from the file's "version" field, not from the environment.
    expect(printed).toContain('2026-11-14.2')

    const { rows } = await db.pool.query<{ handle: string; level: number }>(
      'select handle, level from fans order by handle',
    )
    expect(rows).toEqual([
      { handle: 'ada', level: 3 },
      { handle: 'ben', level: 0 },
    ])
  })

  it('raises nothing on a second "recompute-levels" run over the same table', async () => {
    await db.pool.query(
      `insert into fans (handle, display_name, peak_xp, level)
       values ('ada', 'ada', 800, 3)`,
    )
    const out = capture()

    const code = await runCli(['recompute-levels'], {
      pool: db.pool,
      processors: new Map(),
      out: out.write,
      err: capture().write,
    })

    expect(code).toBe(0)
    expect(out.lines.join('\n')).toContain('raised 0 levels')
    expect(out.lines.join('\n')).toContain('scanned 1 fans')
  })

  it('rejects extra arguments after "recompute-levels" without touching the database', async () => {
    const connect = vi.fn()
    const untouched = { connect, query: vi.fn() } as unknown as Pool
    const err = capture()

    const code = await runCli(['recompute-levels', '--all'], {
      pool: untouched,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(err.lines.join('\n')).toContain('recompute-levels')
    expect(connect).not.toHaveBeenCalled()
  })

  it('exits non-zero and wipes nothing when the confirmation is missing', async () => {
    await seedXp()
    process.env[CONFIG_VERSION_ENV] = '2026-11-14.1'
    const err = capture()

    const code = await runCli(['reset'], {
      pool: db.pool,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(err.lines.join('\n')).toContain(ALPHA_RESET_CONFIRM_ENV)
    expect(await countRows('xp_entries')).toBe(1)
    const { rows } = await db.pool.query<{ peak_xp: number }>('select peak_xp from fans')
    expect(rows[0]?.peak_xp).toBe(120)
  })

  it('exits non-zero without a config version, because a wipe needs a version to record', async () => {
    await seedXp()
    process.env[ALPHA_RESET_CONFIRM_ENV] = ALPHA_RESET_CONFIRM_VALUE
    const err = capture()

    const code = await runCli(['reset'], {
      pool: db.pool,
      processors: new Map(),
      out: capture().write,
      err: err.write,
    })

    expect(code).toBe(1)
    expect(err.lines.join('\n')).toContain(CONFIG_VERSION_ENV)
    expect(await countRows('xp_entries')).toBe(1)
  })
})
