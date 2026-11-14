import type { GameConfig } from '@ashuworld/gameconfig'
import type { ProviderName } from '@ashuworld/providers'
import { awardOnce } from './award.js'
import type { Queryable } from './db.js'

/** A calendar month, `YYYY-MM`, as stored in a monthly action key. */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * A month that is not the `YYYY-MM` the monthly keys are built from.
 *
 * The ledger has no table of periods: the month is part of the action key and the
 * idempotency key, and a malformed one would sit in the ledger as a paid period no
 * future run can match. Throwing here keeps the malformed write out of the database.
 */
export class InvalidMonthError extends Error {
  readonly month: string

  constructor(month: string) {
    super(`monthly award: expected a month as YYYY-MM, got ${JSON.stringify(month)}`)
    this.name = 'InvalidMonthError'
    this.month = month
  }
}

/**
 * The UTC calendar month of `now`, as `YYYY-MM`.
 *
 * UTC on purpose: a fan in Auckland and a fan in Los Angeles must agree on which month
 * a credit belongs to, and a server local time zone would move the boundary at midnight
 * somewhere else. The month is a billing period, not a local date.
 */
export function monthKey(now: Date): string {
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

export interface MonthlyAwardInput {
  identityId: string
  provider: ProviderName
  /** The one-time action's key, such as `twitch.follow`. */
  baseActionKey: string
  /** The period being paid, from `monthKey` or a scheduled job that computed it. */
  month: string
  cfg: GameConfig
}

export interface MonthlyAwardResult {
  /** True only for the call that actually inserted the row. */
  awarded: boolean
}

/**
 * Pays one month of an action whose condition still holds.
 *
 * The month is carried by the keys, not by a schema change: the action key becomes
 * `twitch.follow@2026-11` and the idempotency key `monthly:twitch.follow:2026-11`. The
 * existing partial unique index on `(identity_id, action_key)` then makes the first
 * credit of a month the only one, while a different month is a different key and pays
 * again. Re-running a month, or two workers racing it, leaves exactly one row.
 *
 * The amount comes from `cfg.actions[baseActionKey].monthly`; an action without one, or
 * with zero, pays nothing and writes nothing. This function does not decide whether the
 * condition still holds — the platform adapter does — so a caller that stops seeing the
 * follow simply stops calling it. Nothing already credited is removed.
 */
export async function awardMonthly(
  tx: Queryable,
  input: MonthlyAwardInput,
): Promise<MonthlyAwardResult> {
  if (!MONTH_PATTERN.test(input.month)) throw new InvalidMonthError(input.month)

  const def = Object.hasOwn(input.cfg.actions, input.baseActionKey)
    ? input.cfg.actions[input.baseActionKey]
    : undefined
  const monthly = def?.monthly
  if (monthly === undefined || monthly === 0) return { awarded: false }

  const result = await awardOnce(tx, {
    identityId: input.identityId,
    provider: input.provider,
    actionKey: `${input.baseActionKey}@${input.month}`,
    amount: monthly,
    idempotencyKey: `monthly:${input.baseActionKey}:${input.month}`,
    cfg: input.cfg,
  })
  return { awarded: result.awarded }
}
