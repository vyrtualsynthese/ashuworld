import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { actionAmount, type GameConfig } from '@ashuworld/gameconfig'
import type { ProviderName } from '@ashuworld/providers'
import { awardOnce, ensureIdentity, ingestEvent, withTransaction, type Queryable } from '../src/index.js'
import { createTestDb, type TestDb } from './helpers/db.js'

// The amounts come from a config, never from a literal in the test: it proves the
// ledger stores what `actionAmount` says an action pays, which is the wiring the
// worker depends on.
const cfg: GameConfig = {
  version: 'test',
  actions: {
    'twitch.follow': { amount: 50, provider: 'twitch' },
    'youtube.subscribe': { amount: 50, provider: 'youtube' },
  },
  levels: [{ level: 0, minXp: 0 }],
}

/** A connection that answers every statement with no rows, for the fail-closed paths. */
function silent(): Queryable {
  return { query: async () => ({ rows: [] }) }
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

describe('awardOnce', () => {
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
    externalId = 't-1',
    displayHandle = 'ashu',
    provider: ProviderName = 'twitch',
  ): Promise<string> {
    const { id } = await withTransaction(db.pool, (tx) =>
      ensureIdentity(tx, { provider, externalId, displayHandle, displayName: 'Ashu' }),
    )
    return id
  }

  function earn(identityId: string, actionKey: string, idempotencyKey: string) {
    return {
      identityId,
      provider: 'twitch' as const,
      actionKey,
      amount: actionAmount(cfg, actionKey),
      idempotencyKey,
    }
  }

  async function entries(): Promise<EntryRow[]> {
    const { rows } = await db.pool.query<EntryRow>(
      'select id, identity_id, provider, action_key, amount, kind, idempotency_key from xp_entries order by created_at',
    )
    return rows
  }

  it('awards a one-time action once, then refuses a second award', async () => {
    const identityId = await identity()
    const first = await withTransaction(db.pool, (tx) => awardOnce(tx, earn(identityId, 'twitch.follow', 'evt-1')))
    const second = await withTransaction(db.pool, (tx) => awardOnce(tx, earn(identityId, 'twitch.follow', 'evt-2')))
    expect(first.awarded).toBe(true)
    expect(second.awarded).toBe(false)
    expect(await entries()).toHaveLength(1)
  })

  it('names the entry that already spent the one-time key', async () => {
    const identityId = await identity()
    const first = await withTransaction(db.pool, (tx) => awardOnce(tx, earn(identityId, 'twitch.follow', 'evt-1')))
    const second = await withTransaction(db.pool, (tx) => awardOnce(tx, earn(identityId, 'twitch.follow', 'evt-2')))
    expect(first.entryId).not.toBeNull()
    // A caller that wants to reconcile the refused award needs the row, not just `false`.
    expect(second.entryId).toBe(first.entryId)
  })

  it('stores the entry it was asked to store', async () => {
    const identityId = await identity()
    const award = earn(identityId, 'twitch.follow', 'evt-1')
    await withTransaction(db.pool, (tx) => awardOnce(tx, award))
    expect(await entries()).toEqual([
      expect.objectContaining({
        identity_id: identityId,
        provider: 'twitch',
        action_key: 'twitch.follow',
        amount: actionAmount(cfg, 'twitch.follow'),
        kind: 'earn',
        idempotency_key: 'evt-1',
      }),
    ])
  })

  it('lets two different identities earn the same action', async () => {
    const ashu = await identity('t-1', 'ashu')
    const other = await identity('t-2', 'other')
    const first = await withTransaction(db.pool, (tx) => awardOnce(tx, earn(ashu, 'twitch.follow', 'evt-1')))
    const second = await withTransaction(db.pool, (tx) => awardOnce(tx, earn(other, 'twitch.follow', 'evt-2')))
    expect(first.awarded).toBe(true)
    expect(second.awarded).toBe(true)
    expect(await entries()).toHaveLength(2)
  })

  it('lets one identity earn two different actions', async () => {
    const identityId = await identity()
    const first = await withTransaction(db.pool, (tx) => awardOnce(tx, earn(identityId, 'twitch.follow', 'evt-1')))
    const second = await withTransaction(db.pool, (tx) =>
      awardOnce(tx, earn(identityId, 'youtube.subscribe', 'evt-2')),
    )
    expect(first.awarded).toBe(true)
    expect(second.awarded).toBe(true)
    expect(await entries()).toHaveLength(2)
  })

  it('refuses a replayed idempotency key on another action and names the entry that owns it', async () => {
    const identityId = await identity()
    const first = await withTransaction(db.pool, (tx) => awardOnce(tx, earn(identityId, 'twitch.follow', 'evt-1')))
    // Same delivery, different action: the idempotency key is what the event id maps to,
    // so the second insert must hit that unique constraint, not the one-time index.
    const replay = await withTransaction(db.pool, (tx) =>
      awardOnce(tx, earn(identityId, 'youtube.subscribe', 'evt-1')),
    )
    expect(replay.awarded).toBe(false)
    expect(replay.entryId).toBe(first.entryId)
    expect(await entries()).toHaveLength(1)
  })

  it('pays exactly once when concurrent calls race for the same action', async () => {
    const identityId = await identity()
    // Five transactions, all inserting the same (identity, action). The database decides:
    // four block on the partial unique index and come back empty, then read the winner.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        withTransaction(db.pool, (tx) => awardOnce(tx, earn(identityId, 'twitch.follow', `evt-${index}`))),
      ),
    )
    expect(results.filter((result) => result.awarded)).toHaveLength(1)
    expect(new Set(results.map((result) => result.entryId)).size).toBe(1)
    expect(await entries()).toHaveLength(1)
  })

  it('refuses without naming an entry when a conflict leaves no row to read', async () => {
    // A conflict means a row exists, so an empty read back means it was deleted between
    // the insert and the read. The caller must not be told it paid.
    const result = await awardOnce(silent(), earn('00000000-0000-0000-0000-000000000000', 'twitch.follow', 'evt-x'))
    expect(result).toEqual({ awarded: false, entryId: null })
  })
})

describe('ensureIdentity', () => {
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

  const profile = (displayHandle: string) => ({
    provider: 'twitch' as const,
    externalId: 't-1',
    displayHandle,
    displayName: 'Ashu',
  })

  it('returns the same identity when the same profile arrives again', async () => {
    const first = await withTransaction(db.pool, (tx) => ensureIdentity(tx, profile('ashu')))
    const second = await withTransaction(db.pool, (tx) => ensureIdentity(tx, profile('ashu')))
    expect(second.id).toBe(first.id)
    const { rows } = await db.pool.query<{ n: string }>('select count(*)::text as n from provider_identities')
    expect(rows[0]?.n).toBe('1')
  })

  it('follows a rename without creating a second identity', async () => {
    const first = await withTransaction(db.pool, (tx) => ensureIdentity(tx, profile('ashu')))
    const renamed = await withTransaction(db.pool, (tx) => ensureIdentity(tx, profile('ashu_renamed')))
    expect(renamed.id).toBe(first.id)
    const { rows } = await db.pool.query<{ display_handle: string }>('select display_handle from provider_identities')
    expect(rows[0]?.display_handle).toBe('ashu_renamed')
  })

  it('keeps an existing fan link when the provider reports a rename', async () => {
    // A rename arrives on every login; a careless `do update` that writes the whole row
    // would detach the identity and silently take its XP off the account.
    const first = await withTransaction(db.pool, (tx) => ensureIdentity(tx, profile('ashu')))
    const { rows: fans } = await db.pool.query<{ id: string }>(
      `insert into fans (handle, display_name) values ('ashu', 'Ashu') returning id`,
    )
    const fanId = fans[0]?.id
    await db.pool.query(
      `update provider_identities set fan_id = $1, linked_at = now(), first_linked_at = now() where id = $2`,
      [fanId, first.id],
    )
    await withTransaction(db.pool, (tx) => ensureIdentity(tx, profile('ashu_renamed')))
    const { rows } = await db.pool.query<{ fan_id: string | null; linked_at: string | null }>(
      'select fan_id, linked_at from provider_identities where id = $1',
      [first.id],
    )
    expect(rows[0]?.fan_id).toBe(fanId)
    expect(rows[0]?.linked_at).not.toBeNull()
  })

  it('keeps the same external id on different providers apart', async () => {
    const twitch = await withTransaction(db.pool, (tx) =>
      ensureIdentity(tx, { provider: 'twitch', externalId: '1', displayHandle: 'ashu', displayName: 'Ashu' }),
    )
    const youtube = await withTransaction(db.pool, (tx) =>
      ensureIdentity(tx, { provider: 'youtube', externalId: '1', displayHandle: 'ashu', displayName: 'Ashu' }),
    )
    expect(youtube.id).not.toBe(twitch.id)
  })

  it('fails closed when the upsert returns no row', async () => {
    await expect(
      ensureIdentity(silent(), {
        provider: 'twitch',
        externalId: 't-1',
        displayHandle: 'ashu',
        displayName: 'Ashu',
      }),
    ).rejects.toThrow(/returned no row/)
  })
})

describe('ingestEvent', () => {
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

  async function identity(): Promise<string> {
    const { id } = await withTransaction(db.pool, (tx) =>
      ensureIdentity(tx, { provider: 'twitch', externalId: 't-1', displayHandle: 'ashu', displayName: 'Ashu' }),
    )
    return id
  }

  function earn(identityId: string, idempotencyKey: string) {
    return {
      identityId,
      provider: 'twitch' as const,
      actionKey: 'twitch.follow',
      amount: actionAmount(cfg, 'twitch.follow'),
      idempotencyKey,
    }
  }

  async function event(eventId: string) {
    const { rows } = await db.pool.query<{
      payload: unknown
      processed_at: string | null
      attempts: number
    }>('select payload, processed_at, attempts from inbound_events where event_id = $1', [eventId])
    return rows[0]
  }

  it('treats a replayed event id as processed once', async () => {
    const calls: string[] = []
    const handler = async () => {
      calls.push('ran')
    }
    expect(await ingestEvent(db.pool, { provider: 'twitch', eventId: 'e1', payload: {}, handler })).toBe('processed')
    const again = await ingestEvent(db.pool, { provider: 'twitch', eventId: 'e1', payload: {}, handler })
    expect(again).toBe('duplicate')
    expect(calls).toHaveLength(1)
  })

  it('runs the handler on the payload and marks the event processed', async () => {
    const payload = { type: 'follow', follower: 'ashu' }
    const seen: unknown[] = []
    const outcome = await ingestEvent(db.pool, {
      provider: 'twitch',
      eventId: 'e-payload',
      payload,
      handler: async (_tx, received) => {
        seen.push(received)
      },
    })
    expect(outcome).toBe('processed')
    expect(seen).toEqual([payload])
    const row = await event('e-payload')
    expect(row?.payload).toEqual(payload)
    expect(row?.processed_at).not.toBeNull()
    expect(row?.attempts).toBe(0)
  })

  it('accepts a payload of undefined as a json null', async () => {
    // The type is `unknown`, which includes undefined; passing it straight to `jsonb`
    // would send SQL NULL and violate the column's not-null constraint.
    const outcome = await ingestEvent(db.pool, {
      provider: 'twitch',
      eventId: 'e-undefined',
      payload: undefined,
      handler: async () => undefined,
    })
    expect(outcome).toBe('processed')
    expect(await event('e-undefined')).toEqual(expect.objectContaining({ payload: null }))
  })

  it('keeps the same event id on different providers apart', async () => {
    const calls: string[] = []
    const handler = async () => {
      calls.push('ran')
    }
    await ingestEvent(db.pool, { provider: 'twitch', eventId: 'shared', payload: {}, handler })
    expect(await ingestEvent(db.pool, { provider: 'youtube', eventId: 'shared', payload: {}, handler })).toBe(
      'processed',
    )
    expect(calls).toHaveLength(2)
  })

  it('rolls back the award when the handler throws, and leaves the event retryable', async () => {
    const identityId = await identity()
    const boom = new Error('processor blew up')
    const handler = async (tx: Queryable) => {
      await awardOnce(tx, earn(identityId, 'evt-throw'))
      throw boom
    }
    // The original exception reaches the caller; a wrapped one would hide the cause.
    await expect(
      ingestEvent(db.pool, { provider: 'twitch', eventId: 'e-throw', payload: { type: 'follow' }, handler }),
    ).rejects.toBe(boom)

    const { rows } = await db.pool.query<{ n: string }>('select count(*)::text as n from xp_entries')
    expect(rows[0]?.n).toBe('0')
    const row = await event('e-throw')
    expect(row?.processed_at).toBeNull()
    expect(row?.attempts).toBe(1)
    // The event row survives the failed handler so the worker can pick it up again.
    expect(row?.payload).toEqual({ type: 'follow' })
  })

  it('returns one processed result when two deliveries race', async () => {
    let calls = 0
    const handler = async () => {
      calls += 1
    }
    const results = await Promise.all([
      ingestEvent(db.pool, { provider: 'twitch', eventId: 'e-race', payload: {}, handler }),
      ingestEvent(db.pool, { provider: 'twitch', eventId: 'e-race', payload: {}, handler }),
    ])
    expect(results.sort()).toEqual(['duplicate', 'processed'])
    expect(calls).toBe(1)
  })
})
