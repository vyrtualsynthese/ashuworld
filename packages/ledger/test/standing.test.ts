import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GameConfig } from '@ashuworld/gameconfig'
import type { ProviderName } from '@ashuworld/providers'
import {
  awardOnce,
  computeBalance,
  ensureIdentity,
  getStanding,
  recomputeStanding,
  withTransaction,
  type Queryable,
  type Standing,
} from '../src/index.js'
import { createTestDb, type TestDb } from './helpers/db.js'

// The level table is what turns a peak into a level; the action amounts are only
// convenient round numbers for stacking a balance.
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
    { level: 3, minXp: 700 },
  ],
}

function first<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('expected at least one row')
  return row
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settle: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: () => settle?.() }
}

/**
 * A `Queryable` that runs statements normally until one matches `matches`, then stops
 * before it and runs it on release. This is how a test holds a recompute between reading
 * its input and writing, which is the only window in which a demotion can happen.
 */
function pauseWhen(
  inner: Queryable,
  matches: (text: string) => boolean,
  onPause: () => void,
  release: Promise<void>,
): Queryable {
  let paused = false
  return {
    async query<R extends object = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: R[] }> {
      if (!paused && matches(text)) {
        paused = true
        onPause()
        await release
      }
      return inner.query<R>(text, values)
    },
  }
}

describe('standing', () => {
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

  async function seedFan(handle = 'ashu'): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `insert into fans (handle, display_name) values ($1, $1) returning id`,
      [handle],
    )
    return first(rows).id
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

  /**
   * Attaching is normally Task 6's job. This task predates `linkIdentity`, so the tests
   * write the link columns directly; the balance query must already honour them.
   */
  async function attach(identityId: string, fanId: string): Promise<void> {
    await db.pool.query(
      `update provider_identities
          set fan_id = $1, linked_at = now(), first_linked_at = coalesce(first_linked_at, now())
        where id = $2`,
      [fanId, identityId],
    )
  }

  /**
   * The detach that Task 6 will implement: forfeit the identity's earns, then unlink it.
   * Done in SQL here because `detachIdentity` does not exist yet.
   */
  async function detach(identityId: string): Promise<void> {
    await db.pool.query(
      `update xp_entries set forfeited_at = now()
        where identity_id = $1 and kind = 'earn' and forfeited_at is null`,
      [identityId],
    )
    await db.pool.query(
      `update provider_identities set fan_id = null, linked_at = null where id = $1`,
      [identityId],
    )
  }

  async function award(
    identityId: string,
    actionKey: string,
    amount: number,
    idempotencyKey: string,
    provider: ProviderName = 'twitch',
  ): Promise<void> {
    const result = await withTransaction(db.pool, (tx) =>
      awardOnce(tx, { identityId, provider, actionKey, amount, idempotencyKey }),
    )
    expect(result.awarded).toBe(true)
  }

  /** Penalties arrive with Task 6's `addPenalty`; the ledger row is written directly. */
  async function penalize(fanId: string, amount: number, idempotencyKey: string): Promise<void> {
    await db.pool.query(
      `insert into xp_entries (fan_id, provider, action_key, amount, kind, reason, idempotency_key)
       values ($1, 'twitch', 'operator.penalty', $2, 'penalty', 'test penalty', $3)`,
      [fanId, amount, idempotencyKey],
    )
  }

  function balanceOf(fanId: string): Promise<number> {
    return withTransaction(db.pool, (tx) => computeBalance(tx, fanId))
  }

  function recompute(fanId: string): Promise<Standing> {
    return withTransaction(db.pool, (tx) => recomputeStanding(tx, fanId, cfg))
  }

  async function stored(fanId: string): Promise<{ peak_xp: number; level: number }> {
    const { rows } = await db.pool.query<{ peak_xp: number; level: number }>(
      'select peak_xp, level from fans where id = $1',
      [fanId],
    )
    return first(rows)
  }

  describe('computeBalance', () => {
    it('is zero for a fan with no entries', async () => {
      const fanId = await seedFan()
      expect(await balanceOf(fanId)).toBe(0)
    })

    it('sums non-forfeited earns of attached identities and penalties for the fan', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await attach(identityId, fanId)
      await award(identityId, 'twitch.follow', 50, 'earn-1')
      await award(identityId, 'youtube.subscribe', 100, 'earn-2')
      await penalize(fanId, -20, 'penalty-1')
      expect(await balanceOf(fanId)).toBe(130)
    })

    it('counts only attached identities and ignores forfeited earns', async () => {
      const fanId = await seedFan()
      const attached = await seedIdentity('t-1', 'ashu')
      // A fan holds at most one identity per provider, and the detached one is a YouTube
      // account: a detach is about the account, not the provider.
      const detached = await seedIdentity('y-1', 'other', 'youtube')
      await attach(attached, fanId)
      await attach(detached, fanId)
      await award(attached, 'twitch.follow', 50, 'attached-1')
      await award(detached, 'youtube.subscribe', 200, 'detached-1', 'youtube')
      await detach(detached)
      // The detached fan keeps the rows, forfeited; only the attached 50 is live.
      expect(await balanceOf(fanId)).toBe(50)
    })

    it('ignores an identity that is not attached even when its earn is not forfeited', async () => {
      // A live earn pays into an account only while the identity is attached. There are
      // two ways to be off the account without the rows being forfeited: no fan link at
      // all, or a fan link whose `linked_at` was cleared. Both must be excluded; an
      // implementation that trusts `fan_id` alone would pay the second identity's 100.
      const fanId = await seedFan()
      const unlinked = await seedIdentity('t-1', 'ashu', 'twitch')
      const halfLinked = await seedIdentity('y-1', 'other', 'youtube')
      await award(unlinked, 'twitch.follow', 200, 'earn-1')
      await award(halfLinked, 'youtube.subscribe', 100, 'earn-2', 'youtube')
      await db.pool.query(
        'update provider_identities set fan_id = $1, linked_at = null where id = $2',
        [fanId, halfLinked],
      )
      await db.pool.query(
        'update provider_identities set fan_id = null, linked_at = null where id = $1',
        [unlinked],
      )

      expect(await balanceOf(fanId)).toBe(0)
      // Neither earn is forfeited: the attachment is what makes them count.
      const { rows } = await db.pool.query<{ forfeited: boolean }>(
        'select forfeited_at is not null as forfeited from xp_entries',
      )
      expect(rows.map((row) => row.forfeited)).toEqual([false, false])
    })

    it('keeps one fan off another fan\'s balance', async () => {
      const ashu = await seedFan('ashu')
      const other = await seedFan('other')
      const ashuIdentity = await seedIdentity('t-1', 'ashu')
      const otherIdentity = await seedIdentity('t-2', 'other')
      await attach(ashuIdentity, ashu)
      await attach(otherIdentity, other)
      await award(ashuIdentity, 'twitch.follow', 50, 'ashu-1')
      await award(otherIdentity, 'twitch.follow', 300, 'other-1')
      await penalize(ashu, -20, 'ashu-penalty')
      await penalize(other, -100, 'other-penalty')
      expect(await balanceOf(ashu)).toBe(30)
      expect(await balanceOf(other)).toBe(200)
    })
  })

  describe('recomputeStanding', () => {
    it('raises peak and level as xp arrives', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await attach(identityId, fanId)

      await award(identityId, 'twitch.follow', 50, 'earn-1')
      expect(await recompute(fanId)).toEqual({ balance: 50, peakXp: 50, level: 0 })
      expect(await stored(fanId)).toEqual({ peak_xp: 50, level: 0 })

      await award(identityId, 'youtube.subscribe', 100, 'earn-2')
      expect(await recompute(fanId)).toEqual({ balance: 150, peakXp: 150, level: 1 })
      expect(await stored(fanId)).toEqual({ peak_xp: 150, level: 1 })
    })

    it('keeps the level when a penalty lowers the balance', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await attach(identityId, fanId)
      await award(identityId, 'twitch.follow', 50, 'earn-1')
      await award(identityId, 'youtube.subscribe', 100, 'earn-2')
      await recompute(fanId)

      await penalize(fanId, -100, 'penalty-1')
      // Balance is a live number; the level is a record of what the fan reached. A
      // punishment costs xp, never a level.
      expect(await recompute(fanId)).toEqual({ balance: 50, peakXp: 150, level: 1 })
      expect(await stored(fanId)).toEqual({ peak_xp: 150, level: 1 })
    })

    it('keeps the level when a detach forfeits the balance away', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await attach(identityId, fanId)
      await award(identityId, 'twitch.follow', 50, 'earn-1')
      await award(identityId, 'youtube.subscribe', 100, 'earn-2')
      await recompute(fanId)

      await detach(identityId)
      expect(await recompute(fanId)).toEqual({ balance: 0, peakXp: 150, level: 1 })
      expect(await stored(fanId)).toEqual({ peak_xp: 150, level: 1 })
    })

    it('never lowers peak_xp even when called with a smaller balance', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await attach(identityId, fanId)
      await award(identityId, 'twitch.follow', 50, 'earn-1')
      // A fan who reached 500 xp earlier: a later recompute sees only the live 50.
      await db.pool.query('update fans set peak_xp = 500, level = 2 where id = $1', [fanId])

      expect(await recompute(fanId)).toEqual({ balance: 50, peakXp: 500, level: 2 })
      expect(await stored(fanId)).toEqual({ peak_xp: 500, level: 2 })
    })

    it('never lowers a level that is already above the current level table', async () => {
      // If the level table ever shrinks (or a level is granted by hand), the stored level
      // still must not fall. The update therefore takes the greater of both sides.
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await attach(identityId, fanId)
      await award(identityId, 'twitch.follow', 50, 'earn-1')
      await db.pool.query('update fans set peak_xp = 150, level = 4 where id = $1', [fanId])

      expect(await recompute(fanId)).toEqual({ balance: 50, peakXp: 150, level: 4 })
      expect(await stored(fanId)).toEqual({ peak_xp: 150, level: 4 })
    })

    it('allows a negative balance without writing a negative peak', async () => {
      // Penalties can exceed what a fan earned. `peak_xp` has a `>= 0` check, so the
      // greatest() has to keep the floor at zero rather than store the debt.
      const fanId = await seedFan()
      await penalize(fanId, -25, 'penalty-1')

      expect(await recompute(fanId)).toEqual({ balance: -25, peakXp: 0, level: 0 })
      expect(await stored(fanId)).toEqual({ peak_xp: 0, level: 0 })
    })

    it('never writes a level below the one already stored', async () => {
      // The two writes are deliberately run without a transaction here, so a level change
      // can slip in between them. The `greatest` in the second statement is what keeps
      // that level; without it the recompute, knowing only its own table, would demote.
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await attach(identityId, fanId)
      await award(identityId, 'youtube.subscribe', 300, 'earn-1')

      const paused = deferred()
      const release = deferred()
      const pool: Queryable = {
        async query<R extends object = Record<string, unknown>>(
          text: string,
          values?: unknown[],
        ): Promise<{ rows: R[] }> {
          const result = await db.pool.query(text, values)
          return { rows: result.rows as R[] }
        },
      }
      const run = recomputeStanding(
        pauseWhen(
          pool,
          (text) => text.includes('update fans') && text.includes('set level'),
          paused.resolve,
          release.promise,
        ),
        fanId,
        cfg,
      )
      await paused.promise

      // An operator correction, or a level table that once went higher.
      await db.pool.query('update fans set level = 5 where id = $1', [fanId])

      release.resolve()
      expect(await run).toEqual({ balance: 300, peakXp: 300, level: 5 })
      expect(await stored(fanId)).toEqual({ peak_xp: 300, level: 5 })
    })

    it('fails loud when the fan does not exist', async () => {
      // Silently returning zeros for an unknown fan would let a caller believe it read a
      // real account. The missing-row guard is the only fail-closed path here.
      const missing = '00000000-0000-4000-8000-000000000000'
      await expect(recompute(missing)).rejects.toThrow(/no fans row/i)
    })

    it('does not demote when a slow recompute loses a race to a bigger one', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await attach(identityId, fanId)
      await award(identityId, 'twitch.follow', 500, 'earn-1')

      const paused = deferred()
      const release = deferred()
      // The slow call computes balance 500, then waits before writing. In that window a
      // second transaction raises the account to 700 (level 3). A read-then-write
      // implementation would now write peak 500 / level 2 and lose the level.
      const slow = withTransaction(db.pool, (tx) =>
        recomputeStanding(
          pauseWhen(
            tx,
            (text) => text.includes('update fans') && text.includes('set peak_xp'),
            paused.resolve,
            release.promise,
          ),
          fanId,
          cfg,
        ),
      )
      await paused.promise

      await withTransaction(db.pool, async (tx) => {
        await awardOnce(tx, {
          identityId,
          provider: 'twitch',
          actionKey: 'youtube.subscribe',
          amount: 200,
          idempotencyKey: 'earn-2',
        })
        await recomputeStanding(tx, fanId, cfg)
      })
      expect(await stored(fanId)).toEqual({ peak_xp: 700, level: 3 })

      release.resolve()
      // Its own balance is stale (500), but the peak it returns and writes is the real
      // one, and the level stays at 3.
      expect(await slow).toEqual({ balance: 500, peakXp: 700, level: 3 })
      expect(await stored(fanId)).toEqual({ peak_xp: 700, level: 3 })
    })
  })

  describe('getStanding', () => {
    it('reports the live balance beside the stored peak and level without writing', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await attach(identityId, fanId)
      await award(identityId, 'twitch.follow', 50, 'earn-1')
      await award(identityId, 'youtube.subscribe', 100, 'earn-2')

      // Nothing has recomputed yet: the balance is 150 but the record is still at zero.
      expect(await withTransaction(db.pool, (tx) => getStanding(tx, fanId))).toEqual({
        balance: 150,
        peakXp: 0,
        level: 0,
      })
      expect(await stored(fanId)).toEqual({ peak_xp: 0, level: 0 })
    })

    it('reads the fan row and the balance in one statement', async () => {
      // With two statements, a pool-backed call takes two snapshots and a page can show a
      // balance from one moment beside a peak from another. The count pins the single
      // statement; the values pin that the join still finds the fan's rows.
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await attach(identityId, fanId)
      await award(identityId, 'twitch.follow', 50, 'earn-1')

      let statements = 0
      const counting: Queryable = {
        async query<R extends object = Record<string, unknown>>(
          text: string,
          values?: unknown[],
        ): Promise<{ rows: R[] }> {
          statements += 1
          const result = await db.pool.query(text, values)
          return { rows: result.rows as R[] }
        },
      }
      expect(await getStanding(counting, fanId)).toEqual({ balance: 50, peakXp: 0, level: 0 })
      expect(statements).toBe(1)
    })

    it('agrees with a recompute once standing has been updated', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await attach(identityId, fanId)
      await award(identityId, 'youtube.subscribe', 150, 'earn-1')
      const recomputed = await recompute(fanId)
      expect(await withTransaction(db.pool, (tx) => getStanding(tx, fanId))).toEqual(recomputed)
    })

    it('fails loud when the fan does not exist', async () => {
      const missing = '00000000-0000-4000-8000-000000000000'
      await expect(withTransaction(db.pool, (tx) => getStanding(tx, missing))).rejects.toThrow(
        /no fans row/i,
      )
    })
  })
})
