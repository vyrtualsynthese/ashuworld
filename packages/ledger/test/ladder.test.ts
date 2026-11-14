import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GameConfig } from '@ashuworld/gameconfig'
import type { ProviderName } from '@ashuworld/providers'
import {
  addPenalty,
  awardOnce,
  computeBalance,
  createFan,
  detachIdentity,
  ensureIdentity,
  getFanByHandle,
  getStanding,
  linkIdentity,
  listLadder,
  withTransaction,
} from '../src/index.js'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'

// The level table is what turns a peak into a badge: 100 is level 1, 300 is level 2.
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

function first<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('expected at least one row')
  return row
}

describe('ladder', () => {
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

  async function seedFan(handle: string, displayName = handle): Promise<string> {
    const { id } = await withTransaction(db.pool, (tx) =>
      createFan(tx, { handle, displayName }),
    )
    return id
  }

  async function seedIdentity(
    provider: ProviderName,
    externalId: string,
    displayHandle: string,
  ): Promise<string> {
    const { id } = await withTransaction(db.pool, (tx) =>
      ensureIdentity(tx, { provider, externalId, displayHandle, displayName: displayHandle }),
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
    provider: ProviderName,
    actionKey: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<void> {
    const result = await withTransaction(db.pool, (tx) =>
      awardOnce(tx, { identityId, provider, actionKey, amount, idempotencyKey, cfg }),
    )
    expect(result.awarded).toBe(true)
  }

  async function penalise(fanId: string, amount: number): Promise<void> {
    await withTransaction(db.pool, (tx) =>
      addPenalty(tx, {
        fanId,
        amount,
        reason: 'a test punishment',
        actorFanId: fanId,
        cfg,
      }),
    )
  }

  function ladder(): Promise<Awaited<ReturnType<typeof listLadder>>> {
    return withTransaction(db.pool, (tx) => listLadder(tx))
  }

  function profile(handle: string): Promise<Awaited<ReturnType<typeof getFanByHandle>>> {
    return withTransaction(db.pool, (tx) => getFanByHandle(tx, handle))
  }

  describe('listLadder', () => {
    it('ranks linked fans by current balance, not by peak', async () => {
      // ashu reached 500 and was then punished down to 50. Ranking by peak_xp would put
      // ashu first; ranking by what the fan can spend puts bob first.
      const ashu = await seedFan('ashu')
      const ashuTwitch = await seedIdentity('twitch', 't-ashu', 'ashu_tv')
      await link(ashu, ashuTwitch)
      await award(ashuTwitch, 'twitch', 'twitch.follow', 500, 'ashu-earn')
      await penalise(ashu, -450)

      const bob = await seedFan('bob')
      const bobTwitch = await seedIdentity('twitch', 't-bob', 'bob_tv')
      await link(bob, bobTwitch)
      await award(bobTwitch, 'twitch', 'twitch.follow', 150, 'bob-earn')

      // amy, ashu and zoe end on 50; handle ascending is what keeps their order stable.
      const amy = await seedFan('amy')
      const amyTwitch = await seedIdentity('twitch', 't-amy', 'amy_tv')
      await link(amy, amyTwitch)
      await award(amyTwitch, 'twitch', 'twitch.follow', 50, 'amy-earn')

      const zoe = await seedFan('zoe')
      const zoeTwitch = await seedIdentity('twitch', 't-zoe', 'zoe_tv')
      await link(zoe, zoeTwitch)
      await award(zoeTwitch, 'twitch', 'twitch.follow', 50, 'zoe-earn')

      expect(await ladder()).toEqual({
        linked: [
          { handle: 'bob', level: 1, balance: 150 },
          { handle: 'amy', level: 0, balance: 50 },
          { handle: 'ashu', level: 2, balance: 50 },
          { handle: 'zoe', level: 0, balance: 50 },
        ],
        freeStanding: [],
      })

      // A public row carries no database id: the handle is what a reader can follow.
      expect((await ladder()).linked[0]).not.toHaveProperty('fanId')

      // The peak is still the record it was: the ladder simply does not rank by it.
      expect(await withTransaction(db.pool, (tx) => getStanding(tx, ashu))).toEqual({
        balance: 50,
        peakXp: 500,
        level: 2,
      })
    })

    it('lists only never-linked identities as free-standing', async () => {
      const fanId = await seedFan('ashu')
      const everLinked = await seedIdentity('twitch', 't-ever', 'ashu_tv')
      const neverLinked = await seedIdentity('youtube', 'y-never', 'ashu_yt')
      const keeper = await seedIdentity('discord', 'd-keeper', 'ashu_dc')
      // A never-linked identity with no earn has no place on an xp ladder.
      await seedIdentity('dev', 'dev-idle', 'idle_dev')

      await award(everLinked, 'twitch', 'twitch.follow', 50, 'ever-1')
      await award(neverLinked, 'youtube', 'youtube.subscribe', 100, 'never-1')
      await link(fanId, everLinked)
      await link(fanId, keeper)

      // Once detached, everLinked has no fan and its old earns are forfeited, but its
      // `first_linked_at` is set. A later platform event can still pay it a live earn
      // while it is unlinked; that must not put it back on the free-standing ladder.
      await withTransaction(db.pool, (tx) =>
        detachIdentity(tx, { fanId, identityId: everLinked, cfg }),
      )
      await award(everLinked, 'twitch', 'twitch.raid', 25, 'ever-2')
      const { rows } = await db.pool.query<{ first_linked_at: Date | null }>(
        'select first_linked_at from provider_identities where id = $1',
        [everLinked],
      )
      expect(first(rows).first_linked_at).not.toBeNull()

      // The fresh 25 is live, so only `first_linked_at` keeps this row off the list.
      expect(await ladder()).toEqual({
        linked: [{ handle: 'ashu', level: 0, balance: 0 }],
        freeStanding: [
          {
            identityId: neverLinked,
            provider: 'youtube',
            displayHandle: 'ashu_yt',
            xp: 100,
          },
        ],
      })
    })

    // The ladder's balance is a second, grouped form of the rule `computeBalance` runs per
    // fan: one aggregate for the whole table rather than a lateral subquery per row. Two
    // forms of one rule drift unless something compares them, so this pins the number.
    it('reports the balance computeBalance does for every fan it lists', async () => {
      // ashu exercises all three terms: two live earns, a penalty charged to the fan, and
      // a detach that forfeits one identity's xp.
      const ashu = await seedFan('ashu')
      const ashuTwitch = await seedIdentity('twitch', 't-ashu', 'ashu_tv')
      const ashuYoutube = await seedIdentity('youtube', 'y-ashu', 'ashu_yt')
      await link(ashu, ashuTwitch)
      await link(ashu, ashuYoutube)
      await award(ashuTwitch, 'twitch', 'twitch.follow', 150, 'ashu-earn')
      await award(ashuYoutube, 'youtube', 'youtube.subscribe', 100, 'ashu-yt')
      await penalise(ashu, -25)
      await withTransaction(db.pool, (tx) =>
        detachIdentity(tx, { fanId: ashu, identityId: ashuTwitch, cfg }),
      )

      const bob = await seedFan('bob')
      const bobTwitch = await seedIdentity('twitch', 't-bob', 'bob_tv')
      await link(bob, bobTwitch)
      await award(bobTwitch, 'twitch', 'twitch.follow', 50, 'bob-earn')

      // 100 kept from youtube, minus the 25 penalty; the detached twitch earns are gone.
      expect(await ladder()).toEqual({
        linked: [
          { handle: 'ashu', level: 1, balance: 75 },
          { handle: 'bob', level: 0, balance: 50 },
        ],
        freeStanding: [],
      })

      const { linked } = await ladder()
      // The row no longer carries the id, so the comparison joins on the public handle.
      const fanIds = new Map([
        ['ashu', ashu],
        ['bob', bob],
      ])
      const fromComputeBalance: Array<[string, number]> = []
      await withTransaction(db.pool, async (tx) => {
        for (const row of linked) {
          const fanId = fanIds.get(row.handle)
          if (fanId === undefined) throw new Error(`unexpected handle ${row.handle}`)
          fromComputeBalance.push([row.handle, await computeBalance(tx, fanId)])
        }
      })
      expect(linked.map((row) => [row.handle, row.balance])).toEqual(fromComputeBalance)
    })

    it('keeps a fan who forfeited everything on the ladder, at the bottom', async () => {
      const ashu = await seedFan('ashu')
      const earner = await seedIdentity('twitch', 't-ashu', 'ashu_tv')
      const keeper = await seedIdentity('youtube', 'y-ashu', 'ashu_yt')
      await link(ashu, earner)
      await link(ashu, keeper)
      await award(earner, 'twitch', 'twitch.follow', 150, 'ashu-earn')
      await withTransaction(db.pool, (tx) =>
        detachIdentity(tx, { fanId: ashu, identityId: earner, cfg }),
      )

      const bob = await seedFan('bob')
      const bobTwitch = await seedIdentity('twitch', 't-bob', 'bob_tv')
      await link(bob, bobTwitch)
      await award(bobTwitch, 'twitch', 'twitch.follow', 100, 'bob-earn')

      const cleo = await seedFan('cleo')
      const cleoTwitch = await seedIdentity('twitch', 't-cleo', 'cleo_tv')
      await link(cleo, cleoTwitch)

      expect(await ladder()).toEqual({
        linked: [
          { handle: 'bob', level: 1, balance: 100 },
          // Zero balance, level 1 kept from the peak, ordered by handle after bob.
          { handle: 'ashu', level: 1, balance: 0 },
          { handle: 'cleo', level: 0, balance: 0 },
        ],
        // The forfeited identity was once linked, so neither its zero nor its old earns
        // can bring it back to the free-standing list.
        freeStanding: [],
      })
    })
  })

  describe('getFanByHandle', () => {
    it('returns the public profile by handle, with only attached identities', async () => {
      const fanId = await seedFan('ashu', 'Ashu')
      const twitch = await seedIdentity('twitch', 't-ashu', 'ashu_tv')
      const youtube = await seedIdentity('youtube', 'y-ashu', 'ashu_yt')
      await link(fanId, twitch)
      await link(fanId, youtube)
      await award(twitch, 'twitch', 'twitch.follow', 150, 'ashu-earn')

      // Detaching is not allowed on the last identity; the twitch one stays.
      await withTransaction(db.pool, (tx) =>
        detachIdentity(tx, { fanId, identityId: youtube, cfg }),
      )

      // Case and stray whitespace are normalised; storage stays lowercase.
      expect(await profile('  AsHu  ')).toEqual({
        handle: 'ashu',
        displayName: 'Ashu',
        level: 1,
        balance: 150,
        peakXp: 150,
        identities: [{ provider: 'twitch', displayHandle: 'ashu_tv' }],
      })
    })

    it('answers null for an unknown handle', async () => {
      await seedFan('ashu')
      expect(await profile('nobody')).toBeNull()
    })

    it('reports the live balance beside the stored level and peak', async () => {
      const fanId = await seedFan('ashu', 'Ashu')
      const twitch = await seedIdentity('twitch', 't-ashu', 'ashu_tv')
      await link(fanId, twitch)
      await award(twitch, 'twitch', 'twitch.follow', 300, 'ashu-earn')
      await penalise(fanId, -250)

      expect(await profile('ashu')).toEqual({
        handle: 'ashu',
        displayName: 'Ashu',
        level: 2,
        balance: 50,
        peakXp: 300,
        identities: [{ provider: 'twitch', displayHandle: 'ashu_tv' }],
      })
    })
  })
})
