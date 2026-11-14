import type { Pool } from 'pg'
import type { ProviderName } from '@ashuworld/providers'
import { withTransaction, type Queryable } from './db.js'

export interface AwardInput {
  identityId: string
  provider: ProviderName
  actionKey: string
  amount: number
  idempotencyKey: string
}

export interface AwardResult {
  /** True only for the call that actually inserted the row. */
  awarded: boolean
  /** The entry that paid, new or already there; null only if a conflicting row vanished. */
  entryId: string | null
}

export type IngestOutcome = 'processed' | 'duplicate'

export interface IngestEventInput {
  provider: ProviderName
  eventId: string
  payload: unknown
  handler: (tx: Queryable, payload: unknown) => Promise<void>
}

/**
 * Pays a one-time action at most once per identity.
 *
 * The insert is the check: `on conflict do nothing` covers both unique keys on
 * `xp_entries` — the partial `(identity_id, action_key) where kind = 'earn'` index that
 * makes follow/refollow/re-link pay once forever, and the `idempotency_key` that maps a
 * delivery to the entry it already produced. A concurrent caller blocks on the index and
 * then returns no row, so exactly one caller can ever see `awarded: true`.
 *
 * When nothing was inserted, the winning row is read back in the same transaction. There
 * is no read-then-write window to lose: the read only happens after the database has
 * already refused the write.
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
  if (inserted !== undefined) return { awarded: true, entryId: inserted.id }

  // The one-time key was spent: name the row that spent it.
  const spent = await tx.query<{ id: string }>(
    `select id from xp_entries where identity_id = $1 and action_key = $2 and kind = 'earn'`,
    [input.identityId, input.actionKey],
  )
  const oneTime = spent.rows[0]
  if (oneTime !== undefined) return { awarded: false, entryId: oneTime.id }

  // Otherwise the idempotency key was the conflict: a replayed delivery that asked for a
  // different action. Name the entry that owns the key.
  const keyed = await tx.query<{ id: string }>(
    `select id from xp_entries where idempotency_key = $1`,
    [input.idempotencyKey],
  )
  return { awarded: false, entryId: keyed.rows[0]?.id ?? null }
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
 * the increment commits, so the worker sees exactly what the handler threw.
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

    await tx.query('update inbound_events set processed_at = now() where id = $1', [event.id])
    return { kind: 'processed' as const }
  })

  if (outcome.kind === 'failed') throw outcome.error
  return outcome.kind
}
