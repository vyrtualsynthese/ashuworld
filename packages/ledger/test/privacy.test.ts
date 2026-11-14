import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GameConfig } from '@ashuworld/gameconfig'
import type { ProviderName } from '@ashuworld/providers'
import {
  IdentityAttachedError,
  IdentityNotFoundError,
  awardOnce,
  createFan,
  ensureIdentity,
  eraseFan,
  eraseIdentity,
  erasedExternalId,
  exportFan,
  linkIdentity,
  withTransaction,
  type FanExport,
} from '../src/index.js'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'

// The same small table the other ledger suites use: one follow is half of level 1.
const cfg: GameConfig = {
  version: 'test',
  actions: {
    'twitch.follow': { amount: 50, provider: 'twitch' },
    'youtube.subscribe': { amount: 100, provider: 'youtube' },
  },
  levels: [
    { level: 0, minXp: 0 },
    { level: 1, minXp: 100 },
    { level: 2, minXp: 300 },
  ],
  beyond: { step: 1600, factor: 2 },
}

const pepper = 'test-pepper-not-a-secret'

describe('privacy', () => {
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

  async function seedFan(handle = 'ashu', displayName = 'Ashu'): Promise<string> {
    const { id } = await withTransaction(db.pool, (tx) => createFan(tx, { handle, displayName }))
    return id
  }

  async function seedIdentity(
    externalId = 't-1',
    displayHandle = 'ashu',
    provider: ProviderName = 'twitch',
  ): Promise<string> {
    const { id } = await withTransaction(db.pool, (tx) =>
      ensureIdentity(tx, { provider, externalId, displayHandle, displayName: 'Ashu' }),
    )
    return id
  }

  async function link(fanId: string, identityId: string): Promise<void> {
    const result = await withTransaction(db.pool, (tx) =>
      linkIdentity(tx, { fanId, identityId, cfg }),
    )
    expect(result).toEqual({ ok: true })
  }

  async function award(
    identityId: string,
    actionKey: string,
    idempotencyKey: string,
    provider: ProviderName = 'twitch',
  ): Promise<void> {
    const result = await withTransaction(db.pool, (tx) =>
      awardOnce(tx, { identityId, provider, actionKey, amount: 50, idempotencyKey, cfg }),
    )
    expect(result.awarded).toBe(true)
  }

  async function seedSession(fanId: string): Promise<void> {
    await db.pool.query(
      `insert into sessions (id, fan_id, expires_at) values ('sess-1', $1, now() + interval '1 day')`,
      [fanId],
    )
  }

  /**
   * A fan with one linked identity, one live earn and one session: the shape an account
   * has on the day its owner asks to be forgotten.
   */
  async function seedAccount(): Promise<{ fanId: string; identityId: string }> {
    const fanId = await seedFan()
    const identityId = await seedIdentity()
    await link(fanId, identityId)
    await award(identityId, 'twitch.follow', 'idem-1')
    await seedSession(fanId)
    return { fanId, identityId }
  }

  it('erases an account without deleting its rows or its one-time key', async () => {
    const { fanId, identityId } = await seedAccount()

    const result = await withTransaction(db.pool, (tx) => eraseFan(tx, { fanId, pepper }))

    expect(result).toEqual({ identities: 1, forfeitedEntries: 1 })

    const { rows: fans } = await db.pool.query<{
      handle: string
      display_name: string
      erased_at: Date | null
    }>('select handle, display_name, erased_at from fans where id = $1', [fanId])
    expect(fans[0]?.handle).toMatch(/^deleted_[0-9a-f]{16}$/)
    expect(fans[0]?.handle).toHaveLength(24)
    expect(fans[0]?.display_name).toBe('Compte supprimé')
    expect(fans[0]?.erased_at).toBeInstanceOf(Date)

    const { rows: sessions } = await db.pool.query('select 1 from sessions where fan_id = $1', [fanId])
    expect(sessions).toHaveLength(0)

    const { rows: entries } = await db.pool.query<{
      fan_id: string | null
      identity_id: string | null
      forfeited_at: Date | null
    }>('select fan_id, identity_id, forfeited_at from xp_entries where identity_id = $1', [
      identityId,
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.fan_id).toBeNull()
    expect(entries[0]?.identity_id).toBe(identityId)
    expect(entries[0]?.forfeited_at).toBeInstanceOf(Date)
  })

  it('keeps the one-time key: re-linking the erased identity pays nothing', async () => {
    const { fanId, identityId } = await seedAccount()

    await withTransaction(db.pool, (tx) => eraseFan(tx, { fanId, pepper }))

    // The identity is nobody's now, so a fresh account can claim it. The follow it was
    // already paid for must stay spent: the entry survived the erasure, forfeited.
    const freshFanId = await seedFan('fresh', 'Fresh')
    await link(freshFanId, identityId)

    const again = await withTransaction(db.pool, (tx) =>
      awardOnce(tx, {
        identityId,
        provider: 'twitch',
        actionKey: 'twitch.follow',
        amount: 50,
        idempotencyKey: 'idem-2',
        cfg,
      }),
    )
    expect(again.awarded).toBe(false)
    expect(again.reason).toBe('action_spent')
  })

  it('stores a provider id that only the pepper can name', async () => {
    const { fanId } = await seedAccount()

    await withTransaction(db.pool, (tx) => eraseFan(tx, { fanId, pepper }))

    const { rows } = await db.pool.query<{ provider: string; external_id: string }>(
      'select provider, external_id from provider_identities',
    )
    const stored = rows[0]?.external_id ?? ''
    const independent = `erased:${createHmac('sha256', pepper)
      .update('twitch:t-1')
      .digest('hex')}`

    expect(stored).toBe(independent)
    expect(stored).toBe(erasedExternalId(pepper, 'twitch', 't-1'))
    expect(stored).not.toBe('t-1')
    expect(erasedExternalId('another-pepper', 'twitch', 't-1')).not.toBe(stored)
  })

  it('refuses an attached identity and erases a never-linked one', async () => {
    const { fanId, identityId } = await seedAccount()

    await expect(
      withTransaction(db.pool, (tx) => eraseIdentity(tx, { identityId, pepper })),
    ).rejects.toBeInstanceOf(IdentityAttachedError)

    // A second identity that earned before anybody claimed it: it has no account to erase
    // through, so this is the only path that can anonymise it.
    const free = await seedIdentity('t-2', 'ghost')
    await award(free, 'twitch.follow', 'idem-free')

    const result = await withTransaction(db.pool, (tx) => eraseIdentity(tx, { identityId: free, pepper }))
    expect(result).toEqual({ forfeitedEntries: 1 })

    const { rows } = await db.pool.query<{
      external_id: string
      display_handle: string
      fan_id: string | null
    }>('select external_id, display_handle, fan_id from provider_identities where id = $1', [free])
    expect(rows[0]?.external_id).toBe(erasedExternalId(pepper, 'twitch', 't-2'))
    expect(rows[0]?.display_handle).toBe('Compte supprimé')
    expect(rows[0]?.fan_id).toBeNull()

    const { rows: entries } = await db.pool.query<{ forfeited_at: Date | null }>(
      'select forfeited_at from xp_entries where identity_id = $1',
      [free],
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.forfeited_at).toBeInstanceOf(Date)

    await expect(
      withTransaction(db.pool, (tx) => eraseIdentity(tx, { identityId: fanId, pepper })),
    ).rejects.toBeInstanceOf(IdentityNotFoundError)

    // The attached identity was refused, so it still belongs to its account.
    const { rows: attached } = await db.pool.query<{ fan_id: string | null }>(
      'select fan_id from provider_identities where id = $1',
      [identityId],
    )
    expect(attached[0]?.fan_id).toBe(fanId)
  })

  it('exports an active account with its entries and answers null otherwise', async () => {
    const { fanId } = await seedAccount()

    const account = await withTransaction(db.pool, (tx) => exportFan(tx, 'ashu'))
    expect(account).not.toBeNull()
    const exported = account as FanExport
    expect(exported.handle).toBe('ashu')
    expect(exported.displayName).toBe('Ashu')
    expect(exported.balance).toBe(50)
    expect(exported.peakXp).toBe(50)
    expect(exported.level).toBe(0)
    expect(exported.identities).toEqual([
      { provider: 'twitch', displayHandle: 'ashu', linkedAt: expect.any(Date) },
    ])
    expect(exported.entries).toHaveLength(1)
    expect(exported.entries[0]).toMatchObject({
      provider: 'twitch',
      actionKey: 'twitch.follow',
      amount: 50,
      kind: 'earn',
      forfeitedAt: null,
    })

    expect(await withTransaction(db.pool, (tx) => exportFan(tx, 'nobody'))).toBeNull()

    await withTransaction(db.pool, (tx) => eraseFan(tx, { fanId, pepper }))
    const { rows } = await db.pool.query<{ handle: string }>(
      'select handle from fans where id = $1',
      [fanId],
    )
    expect(await withTransaction(db.pool, (tx) => exportFan(tx, rows[0]?.handle ?? ''))).toBeNull()
  })
})
