import { levelForXp, type GameConfig } from '@ashuworld/gameconfig'
import type { Queryable } from './db.js'

/**
 * A fan's live balance beside the record of the best standing they ever had.
 *
 * `balance` moves both ways: earns add, penalties subtract, a detach forfeits. `peakXp`
 * and `level` only move forward, which is what makes "a level is never lost" true after
 * a punishment or a detach.
 */
export interface Standing {
  /** What the fan has today: live earns minus penalties. Can be negative. */
  balance: number
  /** The highest balance this fan ever reached. Never decreases. */
  peakXp: number
  /** Derived from `peakXp`, never from `balance`. Never decreases. */
  level: number
}

function firstRow<T>(rows: T[], fanId: string): T {
  const row = rows[0]
  if (row === undefined) {
    // An update or a select that matched no row means the fan does not exist. Inventing
    // zeros would report a real account to a caller that asked about a missing one.
    throw new Error(`standing: no fans row for ${fanId}`)
  }
  return row
}

/**
 * The live-balance select, written once so `computeBalance`, `getStanding` and the public
 * ladder cannot drift apart. `fanRef` is `$1` or a column reference such as `f.id` —
 * always a literal this module supplies, never caller input.
 *
 * Exported for `ladder.ts`: a ladder that ranked fans by a second, hand-written copy of
 * this rule would disagree with every balance the rest of the service shows, and the
 * disagreement would only appear once a detach or a penalty landed.
 */
export function liveBalanceQuery(fanRef: string): string {
  return `select coalesce(sum(e.amount), 0)::int as balance
            from xp_entries e
            left join provider_identities i on i.id = e.identity_id
           where e.forfeited_at is null
             and (
               (e.kind = 'penalty' and e.fan_id = ${fanRef})
               or (e.kind = 'earn' and i.fan_id = ${fanRef} and i.linked_at is not null)
             )`
}

/**
 * The live balance of every fan, in one grouped pass, keyed by `fan_id`.
 *
 * This is the ladder's form of the rule in `liveBalanceQuery`: the same two branches (a
 * fan's penalties, plus the live earns of the identities attached to it) summed per fan,
 * but aggregated once for the whole table instead of once per fan. Two owners of one rule
 * is what this module exists to prevent, so the branches below must change whenever
 * `liveBalanceQuery` changes; `test/ladder.test.ts` asserts the ladder's number equals
 * `computeBalance` for every fan it lists.
 *
 * Why a second form: `liveBalanceQuery` is written per fan, and the ladder joined it
 * laterally, so the planner ran it once per row of `fans`. The `or` across the two
 * ownership branches cannot be served by one index, and the measured plan rescanned the
 * whole ledger per fan (2,000 fans over 102,000 entries: 26.5 s). Grouped, the same rule
 * is one pass and the penalty branch uses `xp_entries_fan_live` (30 ms).
 *
 * A fan with no entries at all is simply absent; callers coalesce to 0.
 */
export function liveBalancesQuery(): string {
  return `select fan_id, sum(amount)::int as balance
            from (
              select i.fan_id, e.amount
                from xp_entries e
                join provider_identities i on i.id = e.identity_id
               where e.kind = 'earn'
                 and e.forfeited_at is null
                 and i.fan_id is not null
                 and i.linked_at is not null
              union all
              select e.fan_id, e.amount
                from xp_entries e
               where e.kind = 'penalty'
                 and e.forfeited_at is null
                 and e.fan_id is not null
            ) parts
           group by fan_id`
}

/**
 * The fan's spendable xp: penalties charged to the fan personally, plus the live earns
 * of the identities currently attached to it.
 *
 * Counted in one statement so the answer is one snapshot: a concurrent award either is
 * fully in the sum or fully out of it. The two ownership rules are deliberately
 * different:
 *
 * - a penalty belongs to the fan (`fan_id`) because it survives a detach — a punishment
 *   must still cost something after the account that earned it is unlinked;
 * - an earn belongs to an identity and counts only while that identity is attached
 *   (`fan_id` and `linked_at`). A detached identity keeps its rows, forfeited, so the
 *   spent one-time action stays spent without its xp paying into the old account.
 */
export async function computeBalance(tx: Queryable, fanId: string): Promise<number> {
  const { rows } = await tx.query<{ balance: number }>(liveBalanceQuery('$1'), [fanId])
  // An aggregate returns exactly one row, even over an empty set (the `coalesce` turns
  // its null sum into 0). There is no missing-row case to guard against here.
  return (rows[0] as { balance: number }).balance
}

/**
 * Brings `fans.peak_xp` and `fans.level` up to what the ledger now says, and returns the
 * fan's standing. Call it inside the transaction that changed the balance, so the award
 * and the standing it produces commit together.
 *
 * The peak is raised by the database, not by this code:
 *
 * ```sql
 * update fans set peak_xp = greatest(peak_xp, $2) where id = $1 returning peak_xp
 * ```
 *
 * Reading `peak_xp`, taking the larger value in JS, then writing it back leaves a window
 * in which a concurrent award can raise the peak: the stale write then overwrites the
 * higher value. Because `level` would be derived from that stale peak, the fan would be
 * demoted — the one outcome this system promises never happens. `greatest` compares
 * against the row under the update's own row lock, so the returned `peak_xp` is the true
 * stored value even when several recomputes race.
 *
 * The level then comes from that returned peak, never from `balance`. A penalty or a
 * detach can take the balance to zero while the level stays where the fan reached it.
 * The level write also takes `greatest(level, …)`: with a transaction the row is already
 * locked by the peak update, and without one it still cannot lower a level a concurrent
 * caller wrote between the two statements.
 */
export async function recomputeStanding(
  tx: Queryable,
  fanId: string,
  cfg: GameConfig,
): Promise<Standing> {
  const balance = await computeBalance(tx, fanId)

  const raised = await tx.query<{ peak_xp: number; level: number }>(
    `update fans
        set peak_xp = greatest(peak_xp, $2)
      where id = $1
    returning peak_xp, level`,
    [fanId, balance],
  )
  const current = firstRow(raised.rows, fanId)

  const level = levelForXp(cfg, current.peak_xp).level
  if (level <= current.level) {
    return { balance, peakXp: current.peak_xp, level: current.level }
  }

  const settled = await tx.query<{ peak_xp: number; level: number }>(
    `update fans
        set level = greatest(level, $2)
      where id = $1
    returning peak_xp, level`,
    [fanId, level],
  )
  const final = firstRow(settled.rows, fanId)
  return { balance, peakXp: final.peak_xp, level: final.level }
}

/**
 * Reads a fan's standing without changing it: the live balance from the ledger, and the
 * stored peak and level from the account. A caller that wants the record brought up to
 * date calls `recomputeStanding`; this one never writes, so it is safe on a read replica
 * and safe to call from a page render.
 *
 * The fan row and the balance are one statement. Called with a pool rather than a
 * transaction, two statements would each get their own snapshot, and a page could show a
 * balance from one moment beside a peak from another. The lateral aggregate returns a
 * single row, so the join keeps one row per fan.
 */
export async function getStanding(tx: Queryable, fanId: string): Promise<Standing> {
  const { rows } = await tx.query<{ peak_xp: number; level: number; balance: number }>(
    `select f.peak_xp, f.level, live.balance
       from fans f
       cross join lateral (${liveBalanceQuery('f.id')}) live
      where f.id = $1`,
    [fanId],
  )
  const record = firstRow(rows, fanId)
  return { balance: record.balance, peakXp: record.peak_xp, level: record.level }
}
