import type { Pool } from 'pg'
import { levelForXp, type GameConfig } from '@ashuworld/gameconfig'
import { withTransaction, type Queryable } from './db.js'

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

/** What a whole-table level pass did, for the operator who ran it. */
export interface LevelRecompute {
  /** Fans whose stored level moved up. Zero on a second run over the same table. */
  raised: number
  /** Fans examined: every row in `fans`, including those whose level was already right. */
  scanned: number
}

/**
 * Re-reads every fan's stored `peak_xp` through the level table in `cfg` and raises the
 * levels that the new table puts higher. A level never falls, exactly as in
 * `recomputeStanding`.
 *
 * `recomputeStanding` derives the level when an award, link, detach or penalty fires. The
 * level table is versioned configuration, so a `game.json` change can move a threshold
 * under fans who never act again: without this pass, their stored level stays on the old
 * table until their next event, and the profile shows a level the current numbers do not
 * justify. This pass is the missing half of the rule "a level only ever rises for a given
 * peak": the peak is re-read through whatever table is current.
 *
 * One transaction and two statements:
 *
 * 1. read every fan's `peak_xp` and `level` — the derivation is `levelForXp`, the same
 *    function `recomputeStanding` uses, so a second copy of the thresholds cannot exist;
 * 2. raise the rows whose derived level is higher, in one `update … from (values …)`,
 *    taking `greatest(level, …)` so a row this pass decided about cannot be demoted by a
 *    concurrent writer between the two statements.
 *
 * Rows that already match, or that the table would put lower, are not written at all.
 * That is what makes the pass idempotent: a second run finds nothing to raise and reports
 * `raised: 0`. It is also why a fan with no activity is safe: their row is scanned, and
 * unless the current table disagrees with it, nothing happens.
 *
 * Reading the whole table is deliberate at alpha scale (thousands of fans, one pass). A
 * table large enough to make that a problem would need the thresholds in SQL, which would
 * duplicate `levelForXp`; the read is the cheaper of the two problems.
 */
export async function recomputeLevels(pool: Pool, cfg: GameConfig): Promise<LevelRecompute> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string; peak_xp: number; level: number }>(
      'select id, peak_xp, level from fans order by id',
    )

    const raises: Array<{ id: string; level: number }> = []
    for (const fan of rows) {
      const level = levelForXp(cfg, fan.peak_xp).level
      if (level > fan.level) raises.push({ id: fan.id, level })
    }

    if (raises.length === 0) return { raised: 0, scanned: rows.length }

    const values = raises.map((_, index) => `($${index * 2 + 1}::uuid, $${index * 2 + 2}::int)`)
    const parameters = raises.flatMap((fan) => [fan.id, fan.level])
    const { rows: updated } = await tx.query<{ id: string }>(
      `update fans f
          set level = greatest(f.level, v.level)
         from (values ${values.join(', ')}) as v(id, level)
        where f.id = v.id
      returning f.id`,
      parameters,
    )

    return { raised: updated.length, scanned: rows.length }
  })
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
