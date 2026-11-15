import { createHmac, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GameConfig } from '@ashuworld/gameconfig'
import type { ProviderName } from '@ashuworld/providers'
import {
  FanNotFoundError,
  IdentityAttachedError,
  IdentityNotFoundError,
  awardOnce,
  createFan,
  ensureIdentity,
  eraseFan,
  eraseIdentity,
  erasedExternalId,
  exportFan,
  findIdentityForLogin,
  getFanByHandle,
  linkIdentity,
  listLadder,
  purgeBatch,
  withTransaction,
  type FanExport,
} from '../src/index.js'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'

// The same small table the other ledger suites use: one follow is half of level 1.
const cfg: GameConfig = {
  version: 'test',
  actions: {
    'twitch.follow': { amount: 50, provider: 'twitch' },
    // A second twitch action, so a test can pay an identity twice without reusing a key.
    'twitch.raid': { amount: 50, provider: 'twitch' },
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

    expect(result).toEqual({ erased: true, identities: 1, forfeitedEntries: 1 })

    const { rows: fans } = await db.pool.query<{
      handle: string
      display_name: string
      erased_at: Date | null
    }>('select handle, display_name, erased_at from fans where id = $1', [fanId])
    const handle = fans[0]?.handle ?? ''
    expect(handle).toMatch(/^deleted_[0-9a-f]{16}$/)
    expect(handle).toHaveLength(24)
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

    // A retry does nothing: same handle, no second audit row, nothing re-anonymised.
    const retry = await withTransaction(db.pool, (tx) => eraseFan(tx, { fanId, pepper }))
    expect(retry).toEqual({ erased: false, identities: 0, forfeitedEntries: 0 })

    const { rows: again } = await db.pool.query<{ handle: string }>(
      'select handle from fans where id = $1',
      [fanId],
    )
    expect(again[0]?.handle).toBe(handle)

    const { rows: audit } = await db.pool.query<{ n: string }>(
      `select count(*)::text as n from audit_log where kind = 'erase'`,
    )
    expect(audit[0]?.n).toBe('1')
  })

  it('refuses an account id that is not in the table', async () => {
    await expect(
      withTransaction(db.pool, (tx) => eraseFan(tx, { fanId: randomUUID(), pepper })),
    ).rejects.toBeInstanceOf(FanNotFoundError)
  })

  it('keeps the one-time key: re-attaching the erased identity row by id pays nothing', async () => {
    const { fanId, identityId } = await seedAccount()

    await withTransaction(db.pool, (tx) => eraseFan(tx, { fanId, pepper }))

    // The identity is nobody's now, so a fresh account can claim it. It is claimed by id,
    // because the sign-in resolver that reads the peppered hash arrives in Task 10. The
    // follow it was already paid for must stay spent: the entry survived, forfeited.
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
    expect(result).toEqual({ erased: true, forfeitedEntries: 1 })

    const { rows } = await db.pool.query<{
      external_id: string
      display_handle: string
      fan_id: string | null
    }>('select external_id, display_handle, fan_id from provider_identities where id = $1', [free])
    const hashed = erasedExternalId(pepper, 'twitch', 't-2')
    expect(rows[0]?.external_id).toBe(hashed)
    expect(rows[0]?.display_handle).toBe('Compte supprimé')
    expect(rows[0]?.fan_id).toBeNull()

    const { rows: entries } = await db.pool.query<{ forfeited_at: Date | null }>(
      'select forfeited_at from xp_entries where identity_id = $1',
      [free],
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.forfeited_at).toBeInstanceOf(Date)

    // A retry must not hash the hash: the stored value stays what the first call wrote.
    const retry = await withTransaction(db.pool, (tx) =>
      eraseIdentity(tx, { identityId: free, pepper }),
    )
    expect(retry).toEqual({ erased: false, forfeitedEntries: 0 })
    const { rows: kept } = await db.pool.query<{ external_id: string }>(
      'select external_id from provider_identities where id = $1',
      [free],
    )
    expect(kept[0]?.external_id).toBe(hashed)

    // One audit row, counts only: a later erasure of the same row adds none.
    const { rows: audit } = await db.pool.query<{
      fan_id: string | null
      identity_id: string | null
      actor_fan_id: string | null
      detail: { forfeitedEntries: number }
    }>(
      `select fan_id, identity_id, actor_fan_id, detail
         from audit_log where kind = 'erase-identity'`,
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]?.detail).toEqual({ forfeitedEntries: 1 })
    expect(audit[0]?.fan_id).toBeNull()
    expect(audit[0]?.identity_id).toBeNull()
    expect(audit[0]?.actor_fan_id).toBeNull()

    // A random uuid rather than an existing fan id: a fan id would only show that the
    // lookup misses the fans table, not that it misses an identity.
    await expect(
      withTransaction(db.pool, (tx) => eraseIdentity(tx, { identityId: randomUUID(), pepper })),
    ).rejects.toBeInstanceOf(IdentityNotFoundError)

    // The attached identity was refused, so it still belongs to its account.
    const { rows: attached } = await db.pool.query<{ fan_id: string | null }>(
      'select fan_id from provider_identities where id = $1',
      [identityId],
    )
    expect(attached[0]?.fan_id).toBe(fanId)
  })

  describe('findIdentityForLogin', () => {
    it('finds a live identity by its raw provider id', async () => {
      const identityId = await seedIdentity('t-live', 'live_tv')

      const found = await withTransaction(db.pool, (tx) =>
        findIdentityForLogin(tx, { provider: 'twitch', externalId: 't-live', pepper }),
      )

      expect(found).toEqual({ id: identityId, erased: false })
    })

    it('finds an erased identity by the raw id the provider still sends', async () => {
      const { fanId, identityId } = await seedAccount()
      await withTransaction(db.pool, (tx) => eraseFan(tx, { fanId, pepper }))

      // The provider keeps sending the same account id. Only the caller holding the pepper
      // can compute the stored pseudonym, which is what makes the sign-in match possible.
      const found = await withTransaction(db.pool, (tx) =>
        findIdentityForLogin(tx, { provider: 'twitch', externalId: 't-1', pepper }),
      )

      expect(found).toEqual({ id: identityId, erased: true })
    })

    it('never matches the pseudonym of the same id on another provider', async () => {
      const fanId = await seedFan()
      const shared = await seedIdentity('shared', 'shared_tv', 'twitch')
      await link(fanId, shared)
      await withTransaction(db.pool, (tx) => eraseFan(tx, { fanId, pepper }))

      // The pseudonym covers `provider:externalId`, so the owning provider still resolves...
      expect(
        await withTransaction(db.pool, (tx) =>
          findIdentityForLogin(tx, { provider: 'twitch', externalId: 'shared', pepper }),
        ),
      ).toEqual({ id: shared, erased: true })

      // ...and the same raw id on another provider hashes to something else, so it is a
      // stranger there rather than somebody else's erased account.
      expect(
        await withTransaction(db.pool, (tx) =>
          findIdentityForLogin(tx, { provider: 'dev', externalId: 'shared', pepper }),
        ),
      ).toBeNull()
    })

    it('answers null for an unknown provider account and for a wrong pepper', async () => {
      expect(
        await withTransaction(db.pool, (tx) =>
          findIdentityForLogin(tx, { provider: 'twitch', externalId: 't-never', pepper }),
        ),
      ).toBeNull()

      const { fanId } = await seedAccount()
      await withTransaction(db.pool, (tx) => eraseFan(tx, { fanId, pepper }))

      expect(
        await withTransaction(db.pool, (tx) =>
          findIdentityForLogin(tx, {
            provider: 'twitch',
            externalId: 't-1',
            pepper: 'another-pepper',
          }),
        ),
      ).toBeNull()
    })
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

  describe('purge and public exclusion', () => {
    /** Every row in the four tables a purge touches, so a dry run can be compared with itself. */
    async function tableCounts(): Promise<{
      fans: number
      identities: number
      events: number
      audit: number
    }> {
      const { rows } = await db.pool.query<{
        fans: number
        identities: number
        events: number
        audit: number
      }>(
        `select (select count(*)::int from fans) as fans,
                (select count(*)::int from provider_identities) as identities,
                (select count(*)::int from inbound_events) as events,
                (select count(*)::int from audit_log) as audit`,
      )
      const counts = rows[0]
      if (counts === undefined) throw new Error('expected the table counts')
      return counts
    }

    /**
     * One row of each kind the retention rules target, aged in SQL so the test does not
     * depend on when the suite happens to run: an account nobody touched for 1,200 days
     * with one linked identity and a live earn, a provider identity that never joined an
     * account, a processed event past its 30 days, and an audit row past its 3 years.
     */
    async function seedStale(): Promise<void> {
      const fanId = await seedFan('idle', 'Idle')
      const linked = await seedIdentity('t-idle', 'idle_tv')
      await link(fanId, linked)
      await award(linked, 'twitch.follow', 'idem-idle')
      await db.pool.query(
        `update fans set created_at = now() - interval '1200 days' where id = $1`,
        [fanId],
      )

      const ghost = await seedIdentity('t-ghost', 'ghost')
      await db.pool.query(
        `update provider_identities set created_at = now() - interval '1200 days' where id = $1`,
        [ghost],
      )

      await db.pool.query(
        `insert into inbound_events (provider, event_id, payload, received_at, processed_at)
         values ('twitch', 'old-event', '{}'::jsonb, now() - interval '60 days', now()),
                ('twitch', 'fresh-event', '{}'::jsonb, now(), now())`,
      )

      await db.pool.query(
        `insert into audit_log (kind, created_at)
         values ('retention-old', now() - interval '1200 days'),
                ('retention-fresh', now())`,
      )
    }

    it('reports what a purge would remove and writes nothing', async () => {
      const fanId = await seedFan('idle', 'Idle')
      await db.pool.query(
        `update fans set created_at = now() - interval '1200 days' where id = $1`,
        [fanId],
      )
      await db.pool.query(
        `insert into provider_identities (provider, external_id, display_handle, created_at)
         values ('twitch', 't-ghost', 'ghost', now() - interval '1200 days')`,
      )
      await db.pool.query(
        `insert into inbound_events (provider, event_id, payload, received_at, processed_at)
         values ('twitch', 'old-event', '{}'::jsonb, now() - interval '60 days', now())`,
      )
      await db.pool.query(
        `insert into audit_log (kind, created_at) values ('retention-old', now() - interval '1200 days')`,
      )

      const before = await tableCounts()
      const result = await purgeBatch(db.pool, { pepper, dryRun: true })
      expect(result).toEqual({ fans: 1, identities: 1, events: 1, audit: 1 })
      expect(await tableCounts()).toEqual(before)

      const { rows: fans } = await db.pool.query<{ erased_at: Date | null }>(
        'select erased_at from fans where id = $1',
        [fanId],
      )
      expect(fans[0]?.erased_at).toBeNull()
    })

    it('erases the stale rows and keeps the recent ones', async () => {
      await seedStale()
      await seedFan('active', 'Active')

      const result = await purgeBatch(db.pool, { pepper, dryRun: false })
      expect(result).toEqual({ fans: 1, identities: 1, events: 1, audit: 1 })

      const { rows: fans } = await db.pool.query<{
        handle: string
        erased_at: Date | null
      }>(`select handle, erased_at from fans where handle like 'deleted_%'`)
      expect(fans).toHaveLength(1)
      expect(fans[0]?.erased_at).toBeInstanceOf(Date)

      const { rows: identities } = await db.pool.query<{ external_id: string }>(
        `select external_id from provider_identities where provider = 'twitch' order by external_id`,
      )
      expect(identities.map((row) => row.external_id)).toContain(
        erasedExternalId(pepper, 'twitch', 't-ghost'),
      )

      const { rows: events } = await db.pool.query<{ event_id: string }>(
        'select event_id from inbound_events order by event_id',
      )
      expect(events.map((row) => row.event_id)).toEqual(['fresh-event'])

      const { rows: audit } = await db.pool.query<{ kind: string }>(
        `select kind from audit_log where kind like 'retention-%' order by kind`,
      )
      expect(audit.map((row) => row.kind)).toEqual(['retention-fresh'])

      const { rows: active } = await db.pool.query<{ erased_at: Date | null }>(
        `select erased_at from fans where handle = 'active'`,
      )
      expect(active[0]?.erased_at).toBeNull()
    })

    it('reports zeros on a second pass over the same data', async () => {
      await seedStale()

      expect(await purgeBatch(db.pool, { pepper, dryRun: false })).toEqual({
        fans: 1,
        identities: 1,
        events: 1,
        audit: 1,
      })
      expect(await purgeBatch(db.pool, { pepper, dryRun: false })).toEqual({
        fans: 0,
        identities: 0,
        events: 0,
        audit: 0,
      })
    })

    it('honours the limit: one account per pass, the rest left for the next', async () => {
      for (const handle of ['idle_a', 'idle_b', 'idle_c']) {
        const fanId = await seedFan(handle, handle)
        await db.pool.query(
          `update fans set created_at = now() - interval '1200 days' where id = $1`,
          [fanId],
        )
      }

      const result = await purgeBatch(db.pool, { pepper, dryRun: false, limit: 1 })
      expect(result.fans).toBe(1)

      const { rows } = await db.pool.query<{ erased: string; live: string }>(
        `select count(*) filter (where erased_at is not null)::text as erased,
                count(*) filter (where erased_at is null)::text as live
           from fans`,
      )
      expect(rows[0]?.erased).toBe('1')
      expect(rows[0]?.live).toBe('2')
    })

    it('keeps an erased account off the ladder and out of the profile', async () => {
      const fanId = await seedFan('ashu', 'Ashu')
      const identityId = await seedIdentity('t-ashu', 'ashu_tv')
      await link(fanId, identityId)
      await award(identityId, 'twitch.follow', 'idem-ashu')
      await db.pool.query(`update fans set created_at = now() - interval '1200 days' where id = $1`, [
        fanId,
      ])
      await seedFan('fresh', 'Fresh')

      expect((await purgeBatch(db.pool, { pepper, dryRun: false })).fans).toBe(1)

      // The erased account kept its row under a random handle. Querying that new handle is
      // what proves `getFanByHandle` filters on `erased_at` rather than merely missing the
      // old, now-gone handle.
      const { rows } = await db.pool.query<{ handle: string }>(
        'select handle from fans where id = $1',
        [fanId],
      )
      const renamed = rows[0]?.handle ?? ''
      expect(renamed).toMatch(/^deleted_/)

      const { linked } = await withTransaction(db.pool, (tx) => listLadder(tx))
      expect(linked).toEqual([{ handle: 'fresh', level: 0, balance: 0 }])

      expect(await withTransaction(db.pool, (tx) => getFanByHandle(tx, 'ashu'))).toBeNull()
      expect(await withTransaction(db.pool, (tx) => getFanByHandle(tx, renamed))).toBeNull()
    })

    it('keeps an erased never-linked identity off the free-standing ladder', async () => {
      const identityId = await seedIdentity('t-ghost', 'ghost')
      await award(identityId, 'twitch.follow', 'idem-ghost')
      await db.pool.query(
        `update provider_identities set created_at = now() - interval '1200 days' where id = $1`,
        [identityId],
      )

      const before = await withTransaction(db.pool, (tx) => listLadder(tx))
      expect(before.freeStanding.map((row) => row.identityId)).toEqual([identityId])

      expect((await purgeBatch(db.pool, { pepper, dryRun: false })).identities).toBe(1)

      // The erasure forfeits the identity's live earns, which alone would hide the row from
      // the ladder. A later platform event paying the same provider account a fresh earn is
      // what isolates the `erased:` exclusion under test.
      await award(identityId, 'twitch.raid', 'idem-ghost-2')

      const after = await withTransaction(db.pool, (tx) => listLadder(tx))
      expect(after.freeStanding).toEqual([])
    })
  })
})
