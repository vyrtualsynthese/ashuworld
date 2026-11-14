import { randomUUID } from 'node:crypto'
import type { GameConfig } from '@ashuworld/gameconfig'
import { requireTransaction, type Queryable } from './db.js'
import { recomputeStanding } from './standing.js'

/**
 * Why a punishment was refused.
 *
 * This is the code the API layer will put in a 400 response: a caller branches on it, so
 * it is a fixed set of strings rather than the message text.
 */
export type PenaltyErrorCode =
  | 'fan_not_found'
  | 'actor_not_found'
  | 'invalid_amount'
  | 'invalid_reason'

/**
 * The largest amount one punishment may take, as a positive number of xp.
 *
 * The ledger stores balances as 32-bit integers, and the balance query sums them with
 * `sum(...)::int`. An uncapped `Number.MIN_SAFE_INTEGER` passes `Number.isInteger` and
 * would reach Postgres as a value out of range for `integer`; even two large but in-range
 * penalties could overflow the sum. 100,000 is 66 times the highest level threshold
 * (1,500) and 1,333 times the largest action (75), so it does not limit a real
 * punishment, while keeping one row far below the 2,147,483,647 ceiling. It bounds one
 * row, not the running sum; a fan would have to collect more than 21,000 maximum
 * punishments before the sum itself gets close.
 */
export const MAX_PENALTY_XP = 100_000

/**
 * A punishment the ledger would not write, with a message in plain words.
 *
 * The database has its own checks — `amount` is an integer, a penalty needs a reason — but
 * those refuse with a constraint name and a SQLSTATE, which is not something to show an
 * operator. Validation happens before the insert so the caller gets this instead; the
 * database checks stay as the backstop for anything that reaches it another way.
 */
export class PenaltyError extends Error {
  readonly code: PenaltyErrorCode

  constructor(code: PenaltyErrorCode, message: string) {
    super(message)
    this.name = 'PenaltyError'
    this.code = code
  }
}

export interface AddPenaltyInput {
  /** The fan being punished: the row belongs to the account, not to an identity. */
  fanId: string
  /** Must be a negative whole number. The balance moves by exactly this. */
  amount: number
  /** Why, in plain words. Stored trimmed, and shown to the fan. */
  reason: string
  /** The fan who decided the punishment. Must exist. */
  actorFanId: string
  cfg: GameConfig
}

/**
 * Charges a punishment to a fan and returns the entry it wrote.
 *
 * The row is fan-level: `identity_id` is null, `fan_id` is set, `kind = 'penalty'`, and
 * `amount` is negative into the same signed column earns use. That shape is what makes
 * the punishment survive a detach — it names no identity, so detaching one cannot take it
 * off the balance. It is the only write in the ledger that lowers a balance.
 *
 * `provider` has no platform meaning for a punishment. The column is `not null`, so it is
 * filled with `'system'`: the decision came from the channel, not from Twitch or YouTube.
 *
 * Every call gets a fresh `idempotency_key`. An award can key on the platform event that
 * caused it; a punishment has no such event, and two identical punishments are two
 * decisions, not a replay. A constant key would make the second one fail on the unique
 * constraint.
 *
 * Must run inside a transaction (`withTransaction`): the entry and the standing recompute
 * below have to commit together, or a punishment could land while the fan's balance still
 * reads as if it had not. `requireTransaction` enforces that before anything is written.
 *
 * `recomputeStanding` runs last for the balance, but `peak_xp` and `level` only ever move
 * forward there, so the punishment cannot cost the fan a level.
 */
export async function addPenalty(
  tx: Queryable,
  input: AddPenaltyInput,
): Promise<{ entryId: string }> {
  await requireTransaction(tx)

  // The two lookups come first, in the order the caller reads them: the fan being
  // punished, then the fan deciding it. Both are the failures a foreign key would
  // otherwise report as a constraint name, and naming which of the two is missing is what
  // makes the message usable. The pure-value checks on amount and reason follow: a
  // missing account makes a punishment impossible whatever the amount says, so it is the
  // clearer answer, and it costs one indexed lookup.
  const target = await tx.query<{ id: string }>('select id from fans where id = $1', [input.fanId])
  if (target.rows[0] === undefined) {
    throw new PenaltyError(
      'fan_not_found',
      `no fan account exists with id ${input.fanId}, so there is nobody to charge the punishment to`,
    )
  }

  // Checked here because the foreign key would refuse a missing actor with a constraint
  // name and a SQLSTATE, which tells neither the operator nor the fan what went wrong.
  const actor = await tx.query<{ id: string }>('select id from fans where id = $1', [
    input.actorFanId,
  ])
  if (actor.rows[0] === undefined) {
    throw new PenaltyError(
      'actor_not_found',
      `no fan account exists for the acting fan ${input.actorFanId}, and a punishment must name an actor who exists`,
    )
  }

  if (
    !Number.isInteger(input.amount) ||
    input.amount >= 0 ||
    input.amount < -MAX_PENALTY_XP
  ) {
    throw new PenaltyError(
      'invalid_amount',
      `a punishment must lower the balance by between 1 and ${MAX_PENALTY_XP} xp, as a whole number; got ${String(input.amount)}`,
    )
  }

  const reason = input.reason.trim()
  if (reason === '') {
    throw new PenaltyError(
      'invalid_reason',
      'a punishment needs a reason in plain words, and the reason given was empty',
    )
  }

  const { rows } = await tx.query<{ id: string }>(
    `insert into xp_entries (
       identity_id, fan_id, provider, action_key, amount, kind, reason, actor_fan_id,
       idempotency_key
     )
     values (null, $1, 'system', 'penalty', $2, 'penalty', $3, $4, $5)
     returning id`,
    [input.fanId, input.amount, reason, input.actorFanId, `penalty:${randomUUID()}`],
  )
  const inserted = rows[0]
  if (inserted === undefined) {
    // An insert with `returning` yields a row or raises. No row means something this code
    // does not model happened; an undefined id would be stored as if it were an entry.
    throw new Error(`addPenalty: insert returned no row for fan ${input.fanId}`)
  }

  // The punishment and its actor are already on the entry; this is the operator-facing
  // trail the design asks for, next to link and detach. `entryId` is repeated here so two
  // identical punishments can be told apart without going back to the ledger.
  await tx.query(
    `insert into audit_log (kind, fan_id, identity_id, actor_fan_id, detail)
     values ('penalty', $1, null, $2,
             jsonb_build_object('entryId', $3::uuid, 'amount', $4::int, 'reason', $5::text))`,
    [input.fanId, input.actorFanId, inserted.id, input.amount, reason],
  )

  await recomputeStanding(tx, input.fanId, input.cfg)
  return { entryId: inserted.id }
}
