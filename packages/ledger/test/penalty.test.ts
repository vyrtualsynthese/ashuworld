import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GameConfig } from '@ashuworld/gameconfig'
import type { ProviderName } from '@ashuworld/providers'
import {
  MAX_PENALTY_XP,
  PenaltyError,
  addPenalty,
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

// Same table as the other ledger suites: 50 + 100 reaches level 1 (100 xp), and 300 is
// level 2, so a penalty can lower the balance below 100 without touching the badge.
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

interface PenaltyRow {
  identity_id: string | null
  fan_id: string | null
  provider: string
  action_key: string
  amount: number
  kind: string
  reason: string | null
  actor_fan_id: string | null
  idempotency_key: string
  forfeited_at: Date | null
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

describe('penalties', () => {
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

  function penalize(fanId: string, actorFanId: string, amount: number, reason: string) {
    return withTransaction(db.pool, (tx) =>
      addPenalty(tx, { fanId, actorFanId, amount, reason, cfg }),
    )
  }

  function standingOf(fanId: string): Promise<Standing> {
    return withTransaction(db.pool, (tx) => getStanding(tx, fanId))
  }

  /**
   * A detach may never leave a fan with zero identities, so a test that detaches one needs
   * a second identity to keep. It is a different provider, or the fan's one-identity-per-
   * provider rule would refuse the link.
   */
  async function keepAnother(fanId: string, externalId = 'keep-1'): Promise<string> {
    const identityId = await seedIdentity(externalId, 'keeper', 'youtube')
    expect(await link(fanId, identityId)).toEqual({ ok: true })
    return identityId
  }

  async function penaltyRows(fanId: string): Promise<PenaltyRow[]> {
    const { rows } = await db.pool.query<PenaltyRow>(
      `select identity_id, fan_id, provider, action_key, amount, kind, reason, actor_fan_id,
              idempotency_key, forfeited_at
         from xp_entries
        where kind = 'penalty' and fan_id = $1
        order by created_at, id`,
      [fanId],
    )
    return rows
  }

  async function entryCount(): Promise<number> {
    const { rows } = await db.pool.query<{ count: number }>(
      'select count(*)::int as count from xp_entries',
    )
    return first(rows).count
  }

  async function auditRows(): Promise<AuditRow[]> {
    const { rows } = await db.pool.query<AuditRow>(
      'select kind, fan_id, identity_id, actor_fan_id, detail from audit_log order by id',
    )
    return rows
  }

  /** The real transaction, with its audit insert replaced by a failure. Used by the rollback test. */
  function withoutAudit(tx: Queryable): Queryable {
    return {
      async query<R extends object>(text: string, values?: unknown[]): Promise<{ rows: R[] }> {
        if (text.includes('insert into audit_log')) throw new Error('audit log unavailable')
        return tx.query<R>(text, values)
      },
    }
  }

  /**
   * Runs a refusal and returns the typed error, failing the test when the call succeeds or
   * throws something else. The assertion is on `code`, because that is what the API layer
   * will map to a 400 and what a caller branches on; the message is for the operator.
   */
  async function refusal(promise: Promise<unknown>): Promise<PenaltyError> {
    const failure = await promise.then(
      () => {
        throw new Error('expected the penalty to be refused, but it was accepted')
      },
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(PenaltyError)
    return failure as PenaltyError
  }

  it('lowers the balance and keeps the level', async () => {
    const fanId = await seedFan()
    const identityId = await seedIdentity()
    await award(identityId, 'twitch.follow', 50, 'follow-1')
    await award(identityId, 'youtube.subscribe', 100, 'subscribe-1')
    await link(fanId, identityId)
    expect(await standingOf(fanId)).toEqual({ balance: 150, peakXp: 150, level: 1 })

    const { entryId } = await penalize(fanId, fanId, -100, 'spam in chat')

    // The scale moves; the badge does not. Level comes from peak_xp, never from balance.
    expect(await standingOf(fanId)).toEqual({ balance: 50, peakXp: 150, level: 1 })

    const entry = first(await penaltyRows(fanId))
    expect(entry.idempotency_key.startsWith('penalty:')).toBe(true)
    expect(entry.amount).toBe(-100)
    expect(entryId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('survives a detach of every identity', async () => {
    // The trap: if a punishment were stored on the identity, detaching that identity would
    // erase it. The penalty names the fan instead, so it outlives the account it was
    // charged for. The keeper has no earns, so every xp the fan earned is forfeited here.
    const fanId = await seedFan()
    const earningIdentity = await seedIdentity('t-1', 'ashu', 'twitch')
    await award(earningIdentity, 'twitch.follow', 50, 'follow-1')
    await award(earningIdentity, 'youtube.subscribe', 100, 'subscribe-1')
    await link(fanId, earningIdentity)
    const keeper = await keepAnother(fanId)
    await penalize(fanId, fanId, -40, 'spam in chat')
    expect(await standingOf(fanId)).toEqual({ balance: 110, peakXp: 150, level: 1 })

    expect(await detach(fanId, earningIdentity)).toEqual({ ok: true, forfeitedEntries: 2 })

    // 150 of earns are gone, the -40 punishment is not: the balance is negative and the
    // penalty row is still live.
    expect(await standingOf(fanId)).toEqual({ balance: -40, peakXp: 150, level: 1 })
    const attached = await db.pool.query<{ id: string }>(
      'select id from provider_identities where fan_id = $1 and linked_at is not null',
      [fanId],
    )
    expect(attached.rows.map((row) => row.id)).toEqual([keeper])
    const penalty = first(await penaltyRows(fanId))
    expect(penalty.identity_id).toBeNull()
    expect(penalty.forfeited_at).toBeNull()
  })

  it('remembers the high-water mark the fan reached before the punishment', async () => {
    // The worked example from the review: 150 xp (level 1), then 350 more (balance 500,
    // level 2), then a -250 punishment. If the peak were only recomputed at the punishment,
    // it would be max(150, 250) = 250 and the fan would sit at level 1 even though they had
    // earned level 2. The award has to recompute too.
    const fanId = await seedFan()
    const identityId = await seedIdentity()
    await award(identityId, 'twitch.follow', 50, 'follow-1')
    await award(identityId, 'youtube.subscribe', 100, 'subscribe-1')
    await link(fanId, identityId)
    expect(await standingOf(fanId)).toEqual({ balance: 150, peakXp: 150, level: 1 })

    // A different action key: `twitch.follow` is already spent for this identity.
    await award(identityId, 'twitch.cheer', 350, 'cheer-1')
    expect(await standingOf(fanId)).toEqual({ balance: 500, peakXp: 500, level: 2 })

    await penalize(fanId, fanId, -250, 'spam in chat')

    expect(await standingOf(fanId)).toEqual({ balance: 250, peakXp: 500, level: 2 })
  })

  it('rejects a positive amount', async () => {
    const fanId = await seedFan()

    const failure = await refusal(penalize(fanId, fanId, 50, 'spam in chat'))

    expect(failure.code).toBe('invalid_amount')
    expect(failure.message).toMatch(/lower the balance/i)
    expect(await entryCount()).toBe(0)
  })

  it('rejects a zero amount', async () => {
    // Zero is not a punishment: it would write a row that changes nothing and make the
    // ledger look like something happened.
    const fanId = await seedFan()

    const failure = await refusal(penalize(fanId, fanId, 0, 'spam in chat'))

    expect(failure.code).toBe('invalid_amount')
    expect(await entryCount()).toBe(0)
  })

  it('rejects an amount that is not a whole number', async () => {
    const fanId = await seedFan()

    const failure = await refusal(penalize(fanId, fanId, -1.5, 'spam in chat'))

    expect(failure.code).toBe('invalid_amount')
    expect(failure.message).toMatch(/whole number/i)
    expect(await entryCount()).toBe(0)
  })

  it('rejects Number.MIN_SAFE_INTEGER', async () => {
    // `Number.isInteger(MIN_SAFE_INTEGER)` is true and it is negative, so a sign-and-integer
    // check alone lets it through and Postgres answers with `22003 value out of range for
    // type integer` — the opaque message this task exists to prevent.
    const fanId = await seedFan()

    const failure = await refusal(penalize(fanId, fanId, Number.MIN_SAFE_INTEGER, 'spam in chat'))

    expect(failure.code).toBe('invalid_amount')
    expect(failure.message).toContain(String(MAX_PENALTY_XP))
    expect(await entryCount()).toBe(0)
  })

  it('rejects an amount just beyond the ceiling', async () => {
    const fanId = await seedFan()

    const failure = await refusal(penalize(fanId, fanId, -(MAX_PENALTY_XP + 1), 'spam in chat'))

    expect(failure.code).toBe('invalid_amount')
    expect(failure.message).toContain(String(MAX_PENALTY_XP))
    expect(await entryCount()).toBe(0)
  })

  it('accepts a punishment exactly at the ceiling', async () => {
    // The bound is inclusive: it refuses the impossible, it does not quietly shrink the
    // rule the error message states.
    const fanId = await seedFan()

    await penalize(fanId, fanId, -MAX_PENALTY_XP, 'spam in chat')

    expect(await standingOf(fanId)).toEqual({ balance: -MAX_PENALTY_XP, peakXp: 0, level: 0 })
  })

  it('rejects an empty reason', async () => {
    const fanId = await seedFan()

    const failure = await refusal(penalize(fanId, fanId, -10, ''))

    expect(failure.code).toBe('invalid_reason')
    expect(failure.message).toMatch(/reason/i)
    expect(await entryCount()).toBe(0)
  })

  it('rejects a reason that is only whitespace', async () => {
    // The rule is "non-empty after trimming": a reason of spaces would satisfy the
    // database check and tell the fan nothing.
    const fanId = await seedFan()

    const failure = await refusal(penalize(fanId, fanId, -10, '   '))

    expect(failure.code).toBe('invalid_reason')
    expect(await entryCount()).toBe(0)
  })

  it('rejects an actor that does not exist', async () => {
    // The foreign key would refuse this with an opaque message naming a constraint. The
    // caller gets a code it can report instead, before anything is written.
    const fanId = await seedFan()
    const missing = '00000000-0000-4000-8000-000000000000'

    const failure = await refusal(penalize(fanId, missing, -10, 'spam in chat'))

    expect(failure.code).toBe('actor_not_found')
    expect(failure.message).toContain(missing)
    expect(await entryCount()).toBe(0)
  })

  it('rejects a target fan that does not exist', async () => {
    // The foreign key on `fan_id` would refuse this too, but with a constraint name. The
    // caller needs to know that the account being charged is missing.
    const actorId = await seedFan()
    const missing = '00000000-0000-4000-8000-000000000000'

    const failure = await refusal(penalize(missing, actorId, -10, 'spam in chat'))

    expect(failure.code).toBe('fan_not_found')
    expect(failure.message).toContain(missing)
    expect(await entryCount()).toBe(0)
  })

  it('names the missing target fan before the actor and the amount', async () => {
    // The order is part of the contract: one clear failure, not whichever check happens
    // to run first. All three inputs are wrong here, and the missing target is the answer.
    const missing = '00000000-0000-4000-8000-000000000000'

    const failure = await refusal(penalize(missing, missing, 50, ''))

    expect(failure.code).toBe('fan_not_found')
    expect(await entryCount()).toBe(0)
  })

  it('names the missing actor before the amount and the reason', async () => {
    const fanId = await seedFan()
    const missing = '00000000-0000-4000-8000-000000000000'

    const failure = await refusal(penalize(fanId, missing, 50, ''))

    expect(failure.code).toBe('actor_not_found')
    expect(await entryCount()).toBe(0)
  })

  it('refuses to run without a transaction', async () => {
    // The insert and the standing recompute must commit together. On a bare pool the
    // statement autocommits and the recompute can fail after the punishment is permanent.
    const fanId = await seedFan()

    await expect(
      addPenalty(db.pool, { fanId, actorFanId: fanId, amount: -10, reason: 'spam', cfg }),
    ).rejects.toThrow(/SAVEPOINT can only be used in transaction blocks/i)
    expect(await entryCount()).toBe(0)
  })

  it('gives every penalty its own idempotency key', async () => {
    // A punishment has no platform event to key on: two identical penalties are two
    // decisions, not a replay. A constant key would make the second write fail.
    const fanId = await seedFan()

    const firstPenalty = await penalize(fanId, fanId, -30, 'spam in chat')
    const secondPenalty = await penalize(fanId, fanId, -30, 'spam in chat')

    expect(firstPenalty.entryId).not.toBe(secondPenalty.entryId)
    const rows = await penaltyRows(fanId)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.idempotency_key)).size).toBe(2)
    expect(await standingOf(fanId)).toEqual({ balance: -60, peakXp: 0, level: 0 })

    // The audit trail names the ledger entry (F5), so two otherwise identical punishments
    // are still distinguishable there.
    const audits = await auditRows()
    expect(audits.map((row) => String(row.detail['entryId'])).sort()).toEqual(
      [firstPenalty.entryId, secondPenalty.entryId].sort(),
    )
  })

  it('writes a fan-level row with the actor and the trimmed reason', async () => {
    const fanId = await seedFan('ashu')
    const actorId = await seedFan('moderator')

    await penalize(fanId, actorId, -25, '  spam in chat  ')

    const entry = first(await penaltyRows(fanId))
    expect(entry).toMatchObject({
      identity_id: null,
      fan_id: fanId,
      provider: 'system',
      action_key: 'penalty',
      amount: -25,
      kind: 'penalty',
      reason: 'spam in chat',
      actor_fan_id: actorId,
    })
  })

  it('can take the balance below zero without touching the peak', async () => {
    const fanId = await seedFan()
    const identityId = await seedIdentity()
    await award(identityId, 'twitch.follow', 50, 'follow-1')
    await link(fanId, identityId)

    await penalize(fanId, fanId, -80, 'spam in chat')

    // A debt is allowed; the record of what the fan reached is not.
    expect(await standingOf(fanId)).toEqual({ balance: -30, peakXp: 50, level: 0 })
  })

  it('writes the penalty to the audit log with the acting fan', async () => {
    const fanId = await seedFan('ashu')
    const actorId = await seedFan('moderator')

    const { entryId } = await penalize(fanId, actorId, -25, 'spam in chat')

    // No link happened in this test, so the penalty is the only audit row.
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(first(rows)).toMatchObject({
      kind: 'penalty',
      fan_id: fanId,
      identity_id: null,
      actor_fan_id: actorId,
      // F5: the audit row carries the ledger entry it describes.
      detail: { entryId, amount: -25, reason: 'spam in chat' },
    })
  })

  it('writes the ledger row and the audit row in one transaction', async () => {
    // A failure after the ledger insert must take the ledger row with it. An audit trail
    // that disagrees with the accounting is worse than none, and a punishment that
    // committed without its audit row would be invisible to the operator reviewing it.
    const fanId = await seedFan()

    await expect(
      withTransaction(db.pool, (tx) =>
        addPenalty(withoutAudit(tx), {
          fanId,
          actorFanId: fanId,
          amount: -25,
          reason: 'spam in chat',
          cfg,
        }),
      ),
    ).rejects.toThrow(/audit log unavailable/)

    expect(await entryCount()).toBe(0)
    expect(await auditRows()).toHaveLength(0)
    expect(await standingOf(fanId)).toEqual({ balance: 0, peakXp: 0, level: 0 })
  })

  it('fails loud when the insert reports no row', async () => {
    // An insert with `returning` yields a row or raises. No row means something this code
    // does not model happened; returning an undefined id would store a lie.
    const silent: Queryable = {
      async query<R extends object>(text: string): Promise<{ rows: R[] }> {
        if (text.includes('from fans')) return { rows: [{ id: 'actor' } as unknown as R] }
        return { rows: [] }
      },
    }

    await expect(
      addPenalty(silent, {
        fanId: '00000000-0000-4000-8000-000000000001',
        actorFanId: '00000000-0000-4000-8000-000000000002',
        amount: -10,
        reason: 'spam in chat',
        cfg,
      }),
    ).rejects.toThrow(/returned no row/i)
  })
})
