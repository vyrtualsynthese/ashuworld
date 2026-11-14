import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { Pool } from 'pg'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import { migrationFiles } from '../src/migrate.js'
import {
  ALPHA_RESET_CONFIRM_ENV,
  ALPHA_RESET_CONFIRM_VALUE,
  AlphaResetError,
  resetAlpha,
} from '../src/reset.js'

let db: TestDb
let info: MockInstance<typeof console.info>
let savedConfirm: string | undefined

function first<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('expected at least one row')
  return row
}

async function seedFan(handle: string, peakXp: number, level: number): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `insert into fans (handle, display_name, peak_xp, level)
     values ($1, $2, $3, $4) returning id`,
    [handle, handle, peakXp, level],
  )
  return first(rows).id
}

async function seedIdentity(fanId: string, externalId = 'ext-1'): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `insert into provider_identities (provider, external_id, display_handle, fan_id)
     values ('twitch', $1, $2, $3) returning id`,
    [externalId, `twitch_${externalId}`, fanId],
  )
  return first(rows).id
}

async function seedXp(identityId: string | null, fanId: string | null, key: string): Promise<void> {
  await db.pool.query(
    `insert into xp_entries (identity_id, fan_id, provider, action_key, amount, kind, reason, idempotency_key)
     values ($1, $2, 'twitch', 'twitch.follow', 50, $3, $4, $5)`,
    [identityId, fanId, fanId === null ? 'earn' : 'penalty', fanId === null ? null : 'test', key],
  )
}

async function count(table: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>(`select count(*)::int as n from ${table}`)
  return first(rows).n
}

/** Everything a single reset has to clear: one of each table that needs wiping. */
async function seedWipeable(fanId: string): Promise<void> {
  const identityId = await seedIdentity(fanId)
  await seedXp(identityId, null, 'seed-earn')
  await seedXp(null, fanId, 'seed-penalty')
  await db.pool.query(
    `insert into inbound_events (provider, event_id, payload) values ('twitch', 'follow-1', '{}')`,
  )
  await db.pool.query(
    `insert into oauth_handshakes (state, provider, purpose, expires_at)
     values ('state-1', 'dev', 'login', now() + interval '10 minutes')`,
  )
  await db.pool.query(
    `insert into sessions (id, fan_id, expires_at) values ('session-1', $1, now() + interval '1 hour')`,
    [fanId],
  )
  await db.pool.query(`insert into audit_log (kind, fan_id) values ('test.seed', $1)`, [fanId])
}

beforeAll(async () => {
  db = await createTestDb()
})

beforeEach(async () => {
  await db.reset()
  savedConfirm = process.env[ALPHA_RESET_CONFIRM_ENV]
  delete process.env[ALPHA_RESET_CONFIRM_ENV]
  // The reset logs its config version; tests that do not assert on it stay quiet.
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  info.mockRestore()
  if (savedConfirm === undefined) delete process.env[ALPHA_RESET_CONFIRM_ENV]
  else process.env[ALPHA_RESET_CONFIRM_ENV] = savedConfirm
})

afterAll(async () => {
  await db.pool.end()
})

describe('resetAlpha', () => {
  it('wipes xp, identities, sessions, handshakes, events and the audit log but keeps fans', async () => {
    const ada = await seedFan('ada', 120, 3)
    await seedFan('linus', 40, 2)
    await seedWipeable(ada)
    process.env[ALPHA_RESET_CONFIRM_ENV] = ALPHA_RESET_CONFIRM_VALUE

    const result = await resetAlpha(db.pool, { configVersion: '2026-11-14.1' })

    expect(result).toEqual({ deletedEntries: 2, deletedIdentities: 1, deletedSessions: 1 })
    for (const table of [
      'xp_entries',
      'inbound_events',
      'oauth_handshakes',
      'provider_identities',
      'sessions',
      'audit_log',
    ]) {
      expect(await count(table), table).toBe(0)
    }

    // The accounts survive: a launch wipe resets the game, it does not delete the fans
    // who signed up during the alpha.
    expect(await count('fans')).toBe(2)
    const { rows } = await db.pool.query<{ handle: string }>('select handle from fans order by handle')
    expect(rows.map((row) => row.handle)).toEqual(['ada', 'linus'])

    // `restart identity` is part of the contract: the bigserial ids start over, so the
    // first event after the wipe is #1 rather than continuing the alpha's numbering.
    expect(await count('_migrations')).toBe(migrationFiles().length)
    const { rows: next } = await db.pool.query<{ id: string }>(
      `insert into inbound_events (provider, event_id, payload)
       values ('twitch', 'after-reset', '{}') returning id`,
    )
    expect(first(next).id).toBe('1')
  })

  it('zeroes peak_xp and level instead of leaving the alpha ladder in place', async () => {
    await seedFan('ada', 120, 3)
    process.env[ALPHA_RESET_CONFIRM_ENV] = ALPHA_RESET_CONFIRM_VALUE

    await resetAlpha(db.pool, { configVersion: '2026-11-14.1' })

    const { rows } = await db.pool.query<{ handle: string; peak_xp: number; level: number }>(
      'select handle, peak_xp, level from fans',
    )
    expect(rows).toEqual([{ handle: 'ada', peak_xp: 0, level: 0 }])
  })

  it('logs the game config version that the wipe was run against', async () => {
    await seedFan('ada', 10, 1)
    process.env[ALPHA_RESET_CONFIRM_ENV] = ALPHA_RESET_CONFIRM_VALUE

    await resetAlpha(db.pool, { configVersion: '2026-11-14.1' })

    const logged = info.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('2026-11-14.1')
  })

  it('refuses without the confirm environment value, before opening a transaction', async () => {
    const ada = await seedFan('ada', 120, 3)
    await seedWipeable(ada)
    // A pool that fails loudly if anything tries to use it: the confirmation is checked
    // before the reset touches the database, so a refusal must not even connect.
    const connect = vi.fn(() => {
      throw new Error('the reset opened a transaction before checking the confirmation')
    })
    const unusedPool = { connect, query: vi.fn() } as unknown as Pool

    const error: unknown = await resetAlpha(unusedPool, { configVersion: '2026-11-14.1' }).catch(
      (refused: unknown) => refused,
    )

    expect(error).toBeInstanceOf(AlphaResetError)
    expect((error as AlphaResetError).code).toBe('confirmation-required')
    expect((error as Error).message).toContain(ALPHA_RESET_CONFIRM_ENV)
    expect((error as Error).message).toMatch(/not set/i)
    expect((error as Error).message).toMatch(/nothing was deleted/i)
    expect(connect).not.toHaveBeenCalled()

    expect(await count('xp_entries')).toBe(2)
    expect(await count('provider_identities')).toBe(1)
    expect(await count('sessions')).toBe(1)
  })

  it('refuses a confirmation value that is not the exact token', async () => {
    const ada = await seedFan('ada', 120, 3)
    await seedWipeable(ada)
    process.env[ALPHA_RESET_CONFIRM_ENV] = 'RESET-ASHUWORLD'

    const error: unknown = await resetAlpha(db.pool, { configVersion: '2026-11-14.1' }).catch(
      (refused: unknown) => refused,
    )

    expect(error).toBeInstanceOf(AlphaResetError)
    expect((error as Error).message).toMatch(/does not match/i)
    expect((error as Error).message).toMatch(/nothing was deleted/i)
    expect(await count('xp_entries')).toBe(2)
    expect(await count('sessions')).toBe(1)
  })

  it('refuses a blank confirmation value', async () => {
    const ada = await seedFan('ada', 120, 3)
    await seedWipeable(ada)
    process.env[ALPHA_RESET_CONFIRM_ENV] = '   '

    const error: unknown = await resetAlpha(db.pool, { configVersion: '2026-11-14.1' }).catch(
      (refused: unknown) => refused,
    )

    expect(error).toBeInstanceOf(AlphaResetError)
    expect((error as Error).message).toMatch(/blank/i)
    expect((error as Error).message).toMatch(/nothing was deleted/i)
    expect(await count('xp_entries')).toBe(2)
    expect(await count('provider_identities')).toBe(1)
  })
})
