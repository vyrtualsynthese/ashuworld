import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GameConfig } from '@ashuworld/gameconfig'
import type { ProviderName } from '@ashuworld/providers'
import {
  InvalidMonthError,
  awardMonthly,
  awardOnce,
  ensureIdentity,
  getStanding,
  monthKey,
  withTransaction,
} from '../src/index.js'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'

// The monthly amounts are deliberately not the shipped ones on YouTube: a test that
// asserted 5 would pass against a hard-coded 5, so the config has to be the only source.
const cfg: GameConfig = {
  version: 'test',
  actions: {
    'twitch.follow': { amount: 50, provider: 'twitch', monthly: 5 },
    'youtube.subscribe': { amount: 50, provider: 'youtube', monthly: 7 },
    // No monthly amount at all: the bonus is the whole action.
    'discord.member': { amount: 75, provider: 'discord' },
    // Explicit zero: the same decision, written down.
    'dev.ping': { amount: 1, provider: 'dev', monthly: 0 },
  },
  levels: [
    { level: 0, minXp: 0 },
    { level: 1, minXp: 100 },
    { level: 2, minXp: 300 },
  ],
  beyond: { step: 1600, factor: 2 },
}

interface EntryRow {
  id: string
  identity_id: string | null
  provider: string
  action_key: string
  amount: number
  kind: string
  idempotency_key: string
}

describe('monthKey', () => {
  it('renders the UTC calendar month as YYYY-MM', () => {
    expect(monthKey(new Date('2026-11-15T12:00:00Z'))).toBe('2026-11')
    expect(monthKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01')
    expect(monthKey(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12')
  })

  it('uses UTC, not the machine time zone, at the month boundary', () => {
    // Instants whose local date differs from their UTC date. Auckland is ahead of UTC:
    // its 1 November is still October in UTC. Los Angeles is behind: its 30 November
    // evening is already 1 December in UTC.
    expect(monthKey(new Date('2026-11-01T00:30:00+13:00'))).toBe('2026-10')
    expect(monthKey(new Date('2026-11-30T23:30:00-08:00'))).toBe('2026-12')
  })
})

describe('awardMonthly', () => {
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

  async function identity(
    provider: ProviderName = 'twitch',
    externalId = 't-1',
  ): Promise<string> {
    const { id } = await withTransaction(db.pool, (tx) =>
      ensureIdentity(tx, {
        provider,
        externalId,
        displayHandle: 'ashu',
        displayName: 'Ashu',
      }),
    )
    return id
  }

  function pay(identityId: string, baseActionKey: string, month: string) {
    return withTransaction(db.pool, (tx) =>
      awardMonthly(tx, {
        identityId,
        provider: 'twitch',
        baseActionKey,
        month,
        cfg,
      }),
    )
  }

  async function entries(): Promise<EntryRow[]> {
    const { rows } = await db.pool.query<EntryRow>(
      `select id, identity_id, provider, action_key, amount, kind, idempotency_key
         from xp_entries
        order by action_key`,
    )
    return rows
  }

  it('pays the same month once, then refuses the replay', async () => {
    const identityId = await identity()

    const first = await pay(identityId, 'twitch.follow', '2026-11')
    const second = await pay(identityId, 'twitch.follow', '2026-11')

    expect(first).toEqual({ awarded: true })
    expect(second).toEqual({ awarded: false })
    expect(await entries()).toEqual([
      expect.objectContaining({
        identity_id: identityId,
        action_key: 'twitch.follow@2026-11',
        amount: 5,
        idempotency_key: 'monthly:twitch.follow:2026-11',
        kind: 'earn',
      }),
    ])
  })

  it('pays again the next month, as a distinct entry', async () => {
    const identityId = await identity()

    expect(await pay(identityId, 'twitch.follow', '2026-11')).toEqual({ awarded: true })
    expect(await pay(identityId, 'twitch.follow', '2026-12')).toEqual({ awarded: true })
    expect(await entries()).toEqual([
      expect.objectContaining({ action_key: 'twitch.follow@2026-11' }),
      expect.objectContaining({ action_key: 'twitch.follow@2026-12' }),
    ])
  })

  it('takes the amount from the config, not from a number in the code', async () => {
    const identityId = await identity('youtube', 'y-1')

    await pay(identityId, 'youtube.subscribe', '2026-11')

    expect(await entries()).toEqual([
      expect.objectContaining({ action_key: 'youtube.subscribe@2026-11', amount: 7 }),
    ])
  })

  it('pays nothing and writes nothing for an action without a monthly amount', async () => {
    const identityId = await identity()

    expect(await pay(identityId, 'discord.member', '2026-11')).toEqual({ awarded: false })
    expect(await entries()).toEqual([])
  })

  it('pays nothing and writes nothing when the monthly amount is zero', async () => {
    const identityId = await identity('dev', 'dev-1')

    expect(await pay(identityId, 'dev.ping', '2026-11')).toEqual({ awarded: false })
    expect(await entries()).toEqual([])
  })

  it('pays nothing and writes nothing for an action the config does not know', async () => {
    const identityId = await identity()

    expect(await pay(identityId, 'twitch.nope', '2026-11')).toEqual({ awarded: false })
    expect(await entries()).toEqual([])
  })

  it('refuses a malformed month before writing a row', async () => {
    const identityId = await identity()

    for (const month of ['2026-13', '2026-1', '2026-00', 'November', '']) {
      await expect(pay(identityId, 'twitch.follow', month)).rejects.toBeInstanceOf(
        InvalidMonthError,
      )
    }
    expect(await entries()).toEqual([])
  })

  it("includes the bonus and both monthly rows in the fan's balance", async () => {
    const identityId = await identity()
    const { rows } = await db.pool.query<{ id: string }>(
      `insert into fans (handle, display_name) values ('ashu', 'Ashu') returning id`,
    )
    const fanId = rows[0]?.id
    if (fanId === undefined) throw new Error('expected the fan insert to return a row')
    await db.pool.query(
      'update provider_identities set fan_id = $1, linked_at = now() where id = $2',
      [fanId, identityId],
    )

    await withTransaction(db.pool, (tx) =>
      awardOnce(tx, {
        identityId,
        provider: 'twitch',
        actionKey: 'twitch.follow',
        amount: 50,
        idempotencyKey: 'bonus:twitch.follow',
        cfg,
      }),
    )
    await pay(identityId, 'twitch.follow', '2026-11')
    await pay(identityId, 'twitch.follow', '2026-12')

    expect(await withTransaction(db.pool, (tx) => getStanding(tx, fanId))).toEqual({
      balance: 60,
      peakXp: 60,
      level: 0,
    })
  })
})
