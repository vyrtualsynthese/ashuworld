import type { Pool } from 'pg'
import type { GameConfig } from '@ashuworld/gameconfig'
import type { ProviderName } from '@ashuworld/providers'
import { withTransaction, type Queryable } from './db.js'
import { recomputeStanding } from './standing.js'

export interface AwardInput {
  identityId: string
  provider: ProviderName
  actionKey: string
  amount: number
  idempotencyKey: string
  cfg: GameConfig
}

/**
 * Why an award was or was not paid.
 *
 * `action_spent` and `key_seen` are both refusals, and telling them apart matters: the
 * first is the game working as designed, the second usually means a delivery id was
 * reused by a different identity — a caller bug that would otherwise look like an
 * ordinary replay and silently stop paying a subset of fans.
 */
export type AwardReason = 'awarded' | 'action_spent' | 'key_seen'

export interface AwardResult {
  /** True only for the call that actually inserted the row. */
  awarded: boolean
  /**
   * The entry the answer is about: the new row, the row that spent the one-time action,
   * or the row that owns the reused idempotency key. The interface allows null, but no
   * current branch returns it — an unreadable conflict throws instead.
   */
  entryId: string | null
  reason: AwardReason
}

export interface AwardConflictInput {
  provider: ProviderName
  actionKey: string
  idempotencyKey: string
}

/**
 * The insert was refused by a unique constraint whose row cannot be found.
 *
 * `awardOnce` inserts with a bare `on conflict do nothing`, so it catches every unique
 * constraint on `xp_entries`, including one a later migration might add. When neither
 * read-back explains the refusal, the safe answer is not "already paid" — that would
 * stop paying fans with no error and no log — but an exception naming what was refused.
 */
export class AwardConflictError extends Error {
  readonly provider: ProviderName
  readonly actionKey: string
  readonly idempotencyKey: string

  constructor(conflict: AwardConflictInput) {
    super(
      `award conflict for ${conflict.provider} "${conflict.actionKey}" (idempotency key "${conflict.idempotencyKey}"): ` +
        'the insert was refused but no conflicting entry is visible, so a unique constraint ' +
        'on xp_entries matched that this code does not know about',
    )
    this.name = 'AwardConflictError'
    this.provider = conflict.provider
    this.actionKey = conflict.actionKey
    this.idempotencyKey = conflict.idempotencyKey
  }
}

export type IngestOutcome = 'processed' | 'duplicate'

export interface IngestEventInput {
  provider: ProviderName
  eventId: string
  payload: unknown
  handler: (tx: Queryable, payload: unknown) => Promise<void>
}

/**
 * Brings the fan's standing up to date after an earn lands.
 *
 * An identity pays into an account only while it is attached: `fan_id` set and
 * `linked_at` not null, exactly the condition the balance query uses. An identity nobody
 * has linked yet has no account to update, so there is nothing to recompute.
 *
 * Without this, `peak_xp` would freeze at the last link, detach or punishment. A fan who
 * earned their way to level 2 would still be shown level 1 until one of those happened —
 * and a punishment would then recompute from the post-punishment balance and pin the
 * high-water mark below what the fan had actually reached.
 */
async function recomputeAwardedFanStanding(tx: Queryable, input: AwardInput): Promise<void> {
  const { rows } = await tx.query<{ fan_id: string }>(
    `select fan_id
       from provider_identities
      where id = $1 and fan_id is not null and linked_at is not null`,
    [input.identityId],
  )
  const attached = rows[0]
  if (attached === undefined) return
  await recomputeStanding(tx, attached.fan_id, input.cfg)
}

/**
 * Pays a one-time action at most once per identity, and says why.
 *
 * The insert is the check: `on conflict do nothing` covers both unique keys on
 * `xp_entries` — the partial `(identity_id, action_key) where kind = 'earn'` index that
 * makes follow/refollow/re-link pay once forever, and the `idempotency_key` that maps a
 * delivery to the entry it already produced. A concurrent caller blocks on the index and
 * then returns no row, so exactly one caller can ever see `awarded: true`.
 *
 * When nothing was inserted, the winning row is read back in the same transaction, and
 * the read that succeeds names the refusal:
 *
 * - `action_spent`: this identity already earned this action (the row is its own);
 * - `key_seen`: the idempotency key belongs to some entry, possibly another identity's.
 *   The returned `entryId` is then that entry, not this identity's — the caller must
 *   read `reason` before blaming anyone;
 * - neither read finds a row: the database refused for a reason this code does not model,
 *   so it throws `AwardConflictError` instead of reporting a refusal.
 *
 * The one-time action is checked before the key. When both would conflict, the action is
 * the more specific answer: this identity really was paid already, whatever else the key
 * collided with.
 *
 * There is no read-then-write window to lose: the reads only happen after the database
 * has already refused the write.
 *
 * A successful award also recomputes the attached fan's standing in the same transaction,
 * so the badge moves the moment the fan earns. See `recomputeAwardedFanStanding`.
 */
export async function awardOnce(tx: Queryable, input: AwardInput): Promise<AwardResult> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into xp_entries (identity_id, provider, action_key, amount, kind, idempotency_key)
     values ($1, $2, $3, $4, 'earn', $5)
     on conflict do nothing
     returning id`,
    [input.identityId, input.provider, input.actionKey, input.amount, input.idempotencyKey],
  )
  const inserted = rows[0]
  if (inserted !== undefined) {
    await recomputeAwardedFanStanding(tx, input)
    return { awarded: true, entryId: inserted.id, reason: 'awarded' }
  }

  // The one-time key was spent: name the row that spent it.
  const spent = await tx.query<{ id: string }>(
    `select id from xp_entries where identity_id = $1 and action_key = $2 and kind = 'earn'`,
    [input.identityId, input.actionKey],
  )
  const oneTime = spent.rows[0]
  if (oneTime !== undefined) return { awarded: false, entryId: oneTime.id, reason: 'action_spent' }

  // Otherwise the idempotency key was the conflict: a replayed delivery, or another
  // identity handed the same key. Name the entry that owns the key.
  const keyed = await tx.query<{ id: string }>(
    `select id from xp_entries where idempotency_key = $1`,
    [input.idempotencyKey],
  )
  const keyOwner = keyed.rows[0]
  if (keyOwner !== undefined) return { awarded: false, entryId: keyOwner.id, reason: 'key_seen' }

  throw new AwardConflictError(input)
}

/**
 * Runs one inbound provider event at most once.
 *
 * The event row is the lock: `on conflict (provider, event_id) do nothing returning id`
 * makes the first delivery the only one that gets an id, and every replay returns
 * `'duplicate'` without the handler being called. Provider and event id are one key, so
 * two providers can use the same event id.
 *
 * The handler runs inside a savepoint of the event's transaction. A handler that throws
 * is rolled back to the savepoint — its award and the `processed_at` mark both disappear —
 * while the event row itself stays, unprocessed, with `attempts` incremented. That is
 * what makes a retry possible and measurable; the original exception is rethrown after
 * the increment commits, so the worker sees exactly what the handler threw. A successful
 * handler releases the savepoint so the transaction does not carry an open subtransaction
 * until commit.
 *
 * The handler contract: it must write only through the `tx` it is given, and must not
 * issue its own `commit`, `rollback` or `savepoint` statements. The savepoint is what
 * contains a failure; a handler that ends or rewrites the transaction it was handed can
 * commit a half-applied award, and nothing in this function can undo that.
 */
export async function ingestEvent(pool: Pool, input: IngestEventInput): Promise<IngestOutcome> {
  const outcome = await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into inbound_events (provider, event_id, payload)
       values ($1, $2, $3)
       on conflict (provider, event_id) do nothing
       returning id`,
      [input.provider, input.eventId, JSON.stringify(input.payload ?? null)],
    )
    const event = rows[0]
    if (event === undefined) return { kind: 'duplicate' as const }

    await tx.query('savepoint award_handler')
    try {
      await input.handler(tx, input.payload)
    } catch (error) {
      await tx.query('rollback to savepoint award_handler')
      // After the rollback, so the count survives the handler's failure. The event row
      // was inserted before the savepoint and is not affected by it.
      await tx.query('update inbound_events set attempts = attempts + 1 where id = $1', [event.id])
      return { kind: 'failed' as const, error }
    }
    await tx.query('release savepoint award_handler')

    await tx.query('update inbound_events set processed_at = now() where id = $1', [event.id])
    return { kind: 'processed' as const }
  })

  if (outcome.kind === 'failed') throw outcome.error
  return outcome.kind
}

export interface EnqueueEventInput {
  provider: ProviderName
  eventId: string
  payload: unknown
}

/** `queued` only for the call that inserted the row; `duplicate` for a redelivered event. */
export type EnqueueOutcome = 'queued' | 'duplicate'

/**
 * Writes one connector event for the worker to pick up.
 *
 * Insert only: it must not run a handler, because the api and the connectors have no
 * business opening the award transaction. `on conflict do nothing ... returning` is what
 * distinguishes a first delivery from a redelivery in one statement, without a read that
 * a concurrent writer could invalidate.
 */
export async function enqueueEvent(pool: Pool, input: EnqueueEventInput): Promise<EnqueueOutcome> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into inbound_events (provider, event_id, payload)
     values ($1, $2, $3)
     on conflict (provider, event_id) do nothing
     returning id`,
    [input.provider, input.eventId, JSON.stringify(input.payload ?? null)],
  )
  return rows[0] === undefined ? 'duplicate' : 'queued'
}
