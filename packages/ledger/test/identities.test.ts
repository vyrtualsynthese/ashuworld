import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GameConfig } from '@ashuworld/gameconfig'
import type { ProviderName } from '@ashuworld/providers'
import {
  HandleTakenError,
  awardOnce,
  createFan,
  detachIdentity,
  ensureIdentity,
  getStanding,
  linkIdentity,
  withTransaction,
  type Queryable,
  type Standing,
} from '../src/index.js'
import { createTestDb, type TestDb } from './helpers/db.js'

// The level table is what turns a peak into a badge; the action amounts are round
// numbers that stack to level 1 (100) and then to level 2 (300).
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
}

interface IdentityRow {
  fan_id: string | null
  linked_at: Date | null
  first_linked_at: Date | null
}

interface AuditRow {
  kind: string
  fan_id: string | null
  identity_id: string | null
  actor_fan_id: string | null
  detail: Record<string, unknown>
}

function first<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('expected at least one row')
  return row
}

/** A promise a test can resolve by hand, so it can hold a statement open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let settle: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: () => settle?.() }
}

/**
 * Runs statements normally until one matches `matches`, then stops before it and runs it
 * on release. The gate is what makes a race deterministic: the test decides exactly which
 * statement is in flight when the other transaction starts.
 */
function gateOn(
  inner: Queryable,
  matches: (text: string) => boolean,
  onGate: () => void,
  release: Promise<void>,
): Queryable {
  let gated = false
  return {
    async query<R extends object = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: R[] }> {
      if (!gated && matches(text)) {
        gated = true
        onGate()
        await release
      }
      return inner.query<R>(text, values)
    },
  }
}

/**
 * Reports the backend pid of the connection on its first statement, so the test can ask
 * Postgres whether that backend is waiting on a lock. Without the pid, a lock wait cannot
 * be told apart from a lock another connection of the same database is waiting on.
 */
function withPid(inner: Queryable, onPid: (pid: number) => void): Queryable {
  let asked = false
  return {
    async query<R extends object = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: R[] }> {
      if (!asked) {
        asked = true
        const { rows } = await inner.query<{ pid: number }>('select pg_backend_pid() as pid')
        onPid(first(rows).pid)
      }
      return inner.query<R>(text, values)
    },
  }
}

describe('identities', () => {
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
    const { id } = await withTransaction(db.pool, (tx) =>
      createFan(tx, { handle, displayName: handle }),
    )
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

  function link(fanId: string, identityId: string) {
    return withTransaction(db.pool, (tx) => linkIdentity(tx, { fanId, identityId, cfg }))
  }

  function detach(fanId: string, identityId: string) {
    return withTransaction(db.pool, (tx) => detachIdentity(tx, { fanId, identityId, cfg }))
  }

  async function award(
    identityId: string,
    actionKey: string,
    amount: number,
    idempotencyKey: string,
    provider: ProviderName = 'twitch',
  ): Promise<void> {
    const result = await withTransaction(db.pool, (tx) =>
      awardOnce(tx, { identityId, provider, actionKey, amount, idempotencyKey, cfg }),
    )
    expect(result.awarded).toBe(true)
  }

  function standingOf(fanId: string): Promise<Standing> {
    return withTransaction(db.pool, (tx) => getStanding(tx, fanId))
  }

  /**
   * A detach may never leave a fan with zero identities, so a test that detaches one needs
   * a second one to keep. It is a different provider, or the fan's one-identity-per-provider
   * rule would refuse the link.
   */
  async function keepAnother(fanId: string, externalId = 'keep-1'): Promise<string> {
    const identityId = await seedIdentity(externalId, 'keeper', 'youtube')
    expect(await link(fanId, identityId)).toEqual({ ok: true })
    return identityId
  }

  async function identityRow(identityId: string): Promise<IdentityRow> {
    const { rows } = await db.pool.query<IdentityRow>(
      'select fan_id, linked_at, first_linked_at from provider_identities where id = $1',
      [identityId],
    )
    return first(rows)
  }

  async function attachedIdentityIds(fanId: string): Promise<string[]> {
    const { rows } = await db.pool.query<{ id: string }>(
      `select id from provider_identities
        where fan_id = $1 and linked_at is not null
        order by id`,
      [fanId],
    )
    return rows.map((row) => row.id)
  }

  async function auditRows(): Promise<AuditRow[]> {
    const { rows } = await db.pool.query<AuditRow>(
      'select kind, fan_id, identity_id, actor_fan_id, detail from audit_log order by id',
    )
    return rows
  }

  /**
   * The free-standing half of the ladder, with the predicate Task 7's `listLadder` uses:
   * no fan link and — the rule this task owns — `first_linked_at is null`, so an identity
   * that ever joined an account cannot come back here. Task 7 owns the function, so the
   * predicate is inlined rather than imported.
   */
  async function freeStandingIds(): Promise<string[]> {
    const { rows } = await db.pool.query<{ id: string }>(
      `select i.id
         from provider_identities i
        where i.fan_id is null
          and i.first_linked_at is null
          and exists (
            select 1
              from xp_entries e
             where e.identity_id = i.id
               and e.kind = 'earn'
               and e.forfeited_at is null
          )
        order by i.id`,
    )
    return rows.map((row) => row.id)
  }

  /**
   * Waits until Postgres reports a waiting lock for `pid`. The caller has already put a
   * lock in the way, so this is the proof that the other transaction is genuinely blocked
   * rather than merely started.
   */
  async function waitForLockWait(pid: number): Promise<void> {
    const deadline = Date.now() + 5_000
    for (;;) {
      const { rows } = await db.pool.query<{ waiting: number }>(
        'select count(*)::int as waiting from pg_locks where pid = $1 and not granted',
        [pid],
      )
      if (first(rows).waiting > 0) return
      if (Date.now() > deadline) {
        throw new Error(`backend ${pid} never waited on a lock within 5s`)
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  describe('createFan', () => {
    it('creates the account with its handle and display name', async () => {
      const fanId = await seedFan('ashu')
      const { rows } = await db.pool.query<{ handle: string; display_name: string }>(
        'select handle, display_name from fans where id = $1',
        [fanId],
      )
      expect(first(rows)).toEqual({ handle: 'ashu', display_name: 'ashu' })
    })

    it('names the handle when it is already taken', async () => {
      await seedFan('ashu')
      const failure = await withTransaction(db.pool, (tx) =>
        createFan(tx, { handle: 'ashu', displayName: 'Someone else' }),
      ).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(HandleTakenError)
      expect((failure as Error).message).toContain('ashu')
      expect((failure as HandleTakenError).handle).toBe('ashu')
    })

    it('does not turn any other refusal into a taken handle', async () => {
      // The schema's handle check rejects this: the error must surface as itself, or a
      // caller would go looking for a duplicate that does not exist.
      const failure = await withTransaction(db.pool, (tx) =>
        createFan(tx, { handle: 'Not A Handle', displayName: 'Ashu' }),
      ).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toBeInstanceOf(HandleTakenError)
    })

    it('fails loud when the insert reports no row', async () => {
      // `insert ... returning` yields a row or raises, so Postgres cannot produce this.
      // The guard is what stops an impossible answer from becoming an undefined id that a
      // caller would store as a fan.
      const silent: Queryable = { query: async () => ({ rows: [] }) }
      await expect(
        createFan(silent, { handle: 'ashu', displayName: 'Ashu' }),
      ).rejects.toThrow(/returned no row/i)
    })
  })

  describe('linkIdentity', () => {
    it('stamps first_linked_at and moves the identity to the fan', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()

      expect(await link(fanId, identityId)).toEqual({ ok: true })

      const row = await identityRow(identityId)
      expect(row.fan_id).toBe(fanId)
      expect(row.linked_at).not.toBeNull()
      expect(row.first_linked_at).not.toBeNull()
    })

    it('refuses an identity already owned by another fan', async () => {
      const owner = await seedFan('ashu')
      const other = await seedFan('other')
      const identityId = await seedIdentity()
      expect(await link(owner, identityId)).toEqual({ ok: true })

      expect(await link(other, identityId)).toEqual({ ok: false, reason: 'already_owned' })
      // The refusal changed nothing: the identity is still the first fan's.
      expect((await identityRow(identityId)).fan_id).toBe(owner)
    })

    it('refuses a second identity of the same provider', async () => {
      const fanId = await seedFan()
      const firstIdentity = await seedIdentity('t-1', 'ashu', 'twitch')
      const secondIdentity = await seedIdentity('t-2', 'ashu_alt', 'twitch')
      expect(await link(fanId, firstIdentity)).toEqual({ ok: true })

      expect(await link(fanId, secondIdentity)).toEqual({ ok: false, reason: 'same_provider' })
      expect((await identityRow(secondIdentity)).fan_id).toBeNull()
    })

    it('answers same_provider when a fan links an identity it already holds', async () => {
      // The brief leaves this implicit: the fan holds that provider already — the very
      // identity being offered — so the one-per-provider rule answers, and nothing is
      // written a second time.
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      expect(await link(fanId, identityId)).toEqual({ ok: true })

      expect(await link(fanId, identityId)).toEqual({ ok: false, reason: 'same_provider' })
      expect(await auditRows()).toHaveLength(1)
      expect((await identityRow(identityId)).fan_id).toBe(fanId)
    })

    it('refuses to run without a transaction', async () => {
      // A bare pool autocommits each statement on whichever connection is free: the row
      // lock would end with its statement and the update could land without its audit row
      // or standing recompute. The savepoint pair turns that mistake into a loud failure.
      const fanId = await seedFan()
      const identityId = await seedIdentity()

      await expect(linkIdentity(db.pool, { fanId, identityId, cfg })).rejects.toThrow(
        /SAVEPOINT can only be used in transaction blocks/i,
      )
      expect((await identityRow(identityId)).fan_id).toBeNull()
    })

    it("leaves the caller's transaction usable after a same-provider refusal", async () => {
      // A refusal must not abort the caller's transaction: Postgres silently turns a
      // COMMIT on an aborted transaction into ROLLBACK, so the damage would show up only
      // as work that vanished. The follow-up statement is the proof.
      const fanId = await seedFan()
      const firstIdentity = await seedIdentity('t-1', 'ashu', 'twitch')
      const secondIdentity = await seedIdentity('t-2', 'ashu_alt', 'twitch')
      expect(await link(fanId, firstIdentity)).toEqual({ ok: true })

      const refusal = await withTransaction(db.pool, async (tx) => {
        const result = await linkIdentity(tx, { fanId, identityId: secondIdentity, cfg })
        await tx.query('select 1')
        return result
      })

      expect(refusal).toEqual({ ok: false, reason: 'same_provider' })
      expect((await identityRow(secondIdentity)).fan_id).toBeNull()
    })

    it("brings the identity's existing earns onto the account", async () => {
      // XP arrives before anyone links anything, so a first link must make the fan's
      // standing reflect what the identity already brought.
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await award(identityId, 'twitch.follow', 50, 'follow-1')
      await award(identityId, 'youtube.subscribe', 100, 'subscribe-1')

      expect(await link(fanId, identityId)).toEqual({ ok: true })
      expect(await standingOf(fanId)).toEqual({ balance: 150, peakXp: 150, level: 1 })
    })

    it('fails loud when the identity does not exist', async () => {
      // A caller that mistyped an id must not be told the link happened: there is no row
      // to link, and the result type has no reason for it.
      const fanId = await seedFan()
      await expect(link(fanId, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(
        /no provider_identities row/i,
      )
    })

    it('is safe when two links of the same identity race', async () => {
      // The trap: both transactions read `fan_id is null` and both write, leaving one
      // write silently lost. The identity row lock makes the second caller see the first
      // fan's committed link and answer `already_owned`.
      const firstFan = await seedFan('ashu')
      const secondFan = await seedFan('other')
      const identityId = await seedIdentity()

      const firstGated = deferred()
      const releaseFirst = deferred()
      const secondGated = deferred()
      const releaseSecond = deferred()
      let secondPid: number | undefined

      const first = withTransaction(db.pool, (tx) =>
        linkIdentity(
          gateOn(
            tx,
            (text) => text.includes('insert into audit_log'),
            firstGated.resolve,
            releaseFirst.promise,
          ),
          { fanId: firstFan, identityId, cfg },
        ),
      )
      await firstGated.promise // the first transaction holds the row lock, uncommitted

      const second = withTransaction(db.pool, (tx) =>
        linkIdentity(
          withPid(
            gateOn(
              tx,
              (text) => text.includes('for update'),
              secondGated.resolve,
              releaseSecond.promise,
            ),
            (pid) => {
              secondPid = pid
            },
          ),
          { fanId: secondFan, identityId, cfg },
        ),
      )
      await secondGated.promise
      releaseSecond.resolve()
      if (secondPid === undefined) throw new Error('the second link never reported its pid')
      await waitForLockWait(secondPid) // it is blocked on the first transaction's lock

      releaseFirst.resolve()
      const [firstResult, secondResult] = await Promise.all([first, second])

      expect(firstResult).toEqual({ ok: true })
      expect(secondResult).toEqual({ ok: false, reason: 'already_owned' })
      expect((await identityRow(identityId)).fan_id).toBe(firstFan)
    })

    it('is safe when two identities of one provider race onto one fan', async () => {
      // Two different identities, one fan, one provider: the availability check passes
      // in both transactions before either writes. The unique `(fan_id, provider)` index
      // is the backstop, and its violation must read as `same_provider`, not as an error.
      const fanId = await seedFan()
      const firstIdentity = await seedIdentity('t-1', 'ashu', 'twitch')
      const secondIdentity = await seedIdentity('t-2', 'ashu_alt', 'twitch')

      const firstGated = deferred()
      const releaseFirst = deferred()
      const secondGated = deferred()
      const releaseSecond = deferred()
      let secondPid: number | undefined

      const first = withTransaction(db.pool, (tx) =>
        linkIdentity(
          gateOn(
            tx,
            (text) => text.includes('insert into audit_log'),
            firstGated.resolve,
            releaseFirst.promise,
          ),
          { fanId, identityId: firstIdentity, cfg },
        ),
      )
      await firstGated.promise

      const second = withTransaction(db.pool, async (tx) => {
        const result = await linkIdentity(
          withPid(
            gateOn(
              tx,
              (text) => text.includes('update provider_identities'),
              secondGated.resolve,
              releaseSecond.promise,
            ),
            (pid) => {
              secondPid = pid
            },
          ),
          { fanId, identityId: secondIdentity, cfg },
        )
        // This refusal comes from the unique index, so it is the savepoint rollback that
        // keeps the transaction alive. A statement here fails with 25P02 if the rollback
        // (or its release) is missing — and a COMMIT would otherwise have been silently
        // downgraded to ROLLBACK.
        await tx.query('select 1')
        return result
      })
      await secondGated.promise
      releaseSecond.resolve()
      if (secondPid === undefined) throw new Error('the second link never reported its pid')
      await waitForLockWait(secondPid) // waiting on the first transaction's index entry

      releaseFirst.resolve()
      const [firstResult, secondResult] = await Promise.all([first, second])

      expect(firstResult).toEqual({ ok: true })
      expect(secondResult).toEqual({ ok: false, reason: 'same_provider' })
      expect(await attachedIdentityIds(fanId)).toEqual([firstIdentity])
    })
  })

  describe('detachIdentity', () => {
    it('forfeits earns on detach and keeps the level', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await award(identityId, 'twitch.follow', 50, 'follow-1')
      await award(identityId, 'youtube.subscribe', 100, 'subscribe-1')
      expect(await link(fanId, identityId)).toEqual({ ok: true })
      await keepAnother(fanId)
      expect(await standingOf(fanId)).toEqual({ balance: 150, peakXp: 150, level: 1 })

      expect(await detach(fanId, identityId)).toEqual({ ok: true, forfeitedEntries: 2 })

      expect(await standingOf(fanId)).toEqual({ balance: 0, peakXp: 150, level: 1 })
      // Forfeited, not deleted: the rows are what keep the one-time keys spent.
      const { rows } = await db.pool.query<{ forfeited_at: Date | null; amount: number }>(
        'select forfeited_at, amount from xp_entries order by amount',
      )
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => row.forfeited_at !== null)).toBe(true)
      expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(150)
    })

    it('clears the link but leaves first_linked_at set', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await link(fanId, identityId)
      await keepAnother(fanId)

      expect(await detach(fanId, identityId)).toEqual({ ok: true, forfeitedEntries: 0 })

      const row = await identityRow(identityId)
      expect(row.fan_id).toBeNull()
      expect(row.linked_at).toBeNull()
      expect(row.first_linked_at).not.toBeNull()
    })

    it('never puts a once-linked identity back on the free-standing ladder', async () => {
      const fanId = await seedFan()
      const everLinked = await seedIdentity('t-1', 'ashu', 'twitch')
      const neverLinked = await seedIdentity('y-1', 'other', 'youtube')
      await award(everLinked, 'twitch.follow', 50, 'linked-1')
      await award(neverLinked, 'youtube.subscribe', 100, 'never-1', 'youtube')

      expect(await freeStandingIds()).toEqual([everLinked, neverLinked].sort())

      expect(await link(fanId, everLinked)).toEqual({ ok: true })
      // A second account to keep, so the detach is not refused as the last identity. It is
      // linked, so it is not free-standing either, and it must not be `y-1`.
      await keepAnother(fanId, 'keep-1')
      expect(await detach(fanId, everLinked)).toEqual({ ok: true, forfeitedEntries: 1 })

      // The never-linked identity is still there, so the list is not empty by accident.
      expect(await freeStandingIds()).toEqual([neverLinked])
    })

    it('refuses to detach the last identity', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await award(identityId, 'twitch.follow', 50, 'follow-1')
      await link(fanId, identityId)

      expect(await detach(fanId, identityId)).toEqual({ ok: false, reason: 'last_identity' })

      // Nothing was forfeited or unlinked: the fan keeps the account it can log in with.
      expect(await attachedIdentityIds(fanId)).toEqual([identityId])
      expect(await standingOf(fanId)).toEqual({ balance: 50, peakXp: 50, level: 0 })
    })

    it('refuses an identity that is not attached to this fan', async () => {
      const owner = await seedFan('ashu')
      const other = await seedFan('other')
      const identityId = await seedIdentity()
      await link(owner, identityId)

      // Another fan's identity, and an identity with no fan at all: both are `not_attached`,
      // so neither can be detached into a forfeit from the wrong account.
      expect(await detach(other, identityId)).toEqual({ ok: false, reason: 'not_attached' })
      expect((await identityRow(identityId)).fan_id).toBe(owner)

      const unlinked = await seedIdentity('y-1', 'other', 'youtube')
      expect(await detach(owner, unlinked)).toEqual({ ok: false, reason: 'not_attached' })
      expect((await identityRow(unlinked)).fan_id).toBeNull()
    })

    it('refuses to detach without a transaction', async () => {
      // Without a transaction the fan lock would be released with its statement, the
      // forfeit and the unlink would land separately, and two concurrent detaches could
      // leave the fan with no identity at all. A bare pool must fail before any of that.
      const fanId = await seedFan()
      const identityId = await seedIdentity('t-1', 'ashu', 'twitch')
      await award(identityId, 'twitch.follow', 50, 'follow-1')
      expect(await link(fanId, identityId)).toEqual({ ok: true })
      await keepAnother(fanId)

      await expect(detachIdentity(db.pool, { fanId, identityId, cfg })).rejects.toThrow(
        /SAVEPOINT can only be used in transaction blocks/i,
      )

      // Nothing moved: still attached, nothing forfeited.
      const row = await identityRow(identityId)
      expect(row.fan_id).toBe(fanId)
      expect(row.linked_at).not.toBeNull()
      const { rows } = await db.pool.query<{ forfeited_at: Date | null }>(
        'select forfeited_at from xp_entries where identity_id = $1',
        [identityId],
      )
      expect(rows).toHaveLength(1)
      expect(rows.every((entry) => entry.forfeited_at === null)).toBe(true)
    })

    it('fails loud when the fan or the identity does not exist', async () => {
      const fanId = await seedFan()
      const missing = '00000000-0000-4000-8000-000000000000'
      await expect(detach(missing, missing)).rejects.toThrow(/no fans row/i)

      // The fan exists but the identity does not: that is still not a detach anyone can
      // report as done, and `not_attached` would suggest an identity that is simply
      // unlinked rather than one that is missing.
      await expect(detach(fanId, missing)).rejects.toThrow(/no provider_identities row/i)
    })

    it('does not pay out again when the same identity is re-linked', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await award(identityId, 'twitch.follow', 50, 'follow-1')
      await link(fanId, identityId)
      await keepAnother(fanId)
      expect(await standingOf(fanId)).toEqual({ balance: 50, peakXp: 50, level: 0 })

      await detach(fanId, identityId)
      expect(await link(fanId, identityId)).toEqual({ ok: true })

      expect(await standingOf(fanId)).toEqual({ balance: 0, peakXp: 50, level: 0 })
      const replay = await withTransaction(db.pool, (tx) =>
        awardOnce(tx, {
          identityId,
          provider: 'twitch',
          actionKey: 'twitch.follow',
          amount: 50,
          idempotencyKey: 'follow-1',
          cfg,
        }),
      )
      expect(replay).toMatchObject({ awarded: false, reason: 'action_spent' })
    })

    it('is safe when two detaches of one fan race', async () => {
      // The trap: each transaction counts two attached identities, each detaches one, and
      // the fan is left with none. The fan row lock serialises the count, so the second
      // detach sees one attached identity and refuses.
      const fanId = await seedFan()
      const twitchId = await seedIdentity('t-1', 'ashu', 'twitch')
      const youtubeId = await seedIdentity('y-1', 'other', 'youtube')
      await award(twitchId, 'twitch.follow', 50, 'twitch-1')
      await award(youtubeId, 'youtube.subscribe', 100, 'youtube-1', 'youtube')
      await link(fanId, twitchId)
      await link(fanId, youtubeId)

      const firstGated = deferred()
      const releaseFirst = deferred()
      const secondGated = deferred()
      const releaseSecond = deferred()
      let secondPid: number | undefined

      const first = withTransaction(db.pool, (tx) =>
        detachIdentity(
          gateOn(
            tx,
            (text) => text.includes('insert into audit_log'),
            firstGated.resolve,
            releaseFirst.promise,
          ),
          { fanId, identityId: twitchId, cfg },
        ),
      )
      await firstGated.promise // the first detach holds the fan row, uncommitted

      const second = withTransaction(db.pool, (tx) =>
        detachIdentity(
          withPid(
            gateOn(
              tx,
              (text) => text.includes('for update'),
              secondGated.resolve,
              releaseSecond.promise,
            ),
            (pid) => {
              secondPid = pid
            },
          ),
          { fanId, identityId: youtubeId, cfg },
        ),
      )
      await secondGated.promise
      releaseSecond.resolve()
      if (secondPid === undefined) throw new Error('the second detach never reported its pid')
      await waitForLockWait(secondPid) // blocked behind the first detach's fan lock

      releaseFirst.resolve()
      const [firstResult, secondResult] = await Promise.all([first, second])

      expect(firstResult).toEqual({ ok: true, forfeitedEntries: 1 })
      expect(secondResult).toEqual({ ok: false, reason: 'last_identity' })
      expect(await attachedIdentityIds(fanId)).toEqual([youtubeId])
      expect(await standingOf(fanId)).toEqual({ balance: 100, peakXp: 150, level: 1 })
    })

    it('writes a forfeit to the audit log with the acting fan', async () => {
      const fanId = await seedFan()
      const identityId = await seedIdentity()
      await award(identityId, 'twitch.follow', 50, 'follow-1')
      await award(identityId, 'youtube.subscribe', 100, 'subscribe-1')
      await link(fanId, identityId)
      await keepAnother(fanId)
      await detach(fanId, identityId)

      // Only this identity's history: the keeper's own link is a third row that says
      // nothing about this detach.
      const rows = (await auditRows()).filter((row) => row.identity_id === identityId)
      expect(rows.map((row) => row.kind)).toEqual(['link', 'detach'])
      for (const row of rows) {
        // In this alpha the acting fan is the fan itself.
        expect(row.fan_id).toBe(fanId)
        expect(row.actor_fan_id).toBe(fanId)
        expect(row.identity_id).toBe(identityId)
      }
      expect(rows[1]?.detail).toMatchObject({ forfeitedEntries: 2 })
    })
  })
})
