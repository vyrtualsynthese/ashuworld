import type { Queryable } from './db.js'

/**
 * Records the terms version a fan accepted, the first time only.
 *
 * The `terms_accepted_at is null` guard is what makes the acceptance immutable: consent is
 * evidence of what the fan agreed to at a moment in time, so a later sign-in with a
 * different version must not rewrite it. The first acceptance is kept forever and a later
 * version is not recorded at all, so the stored version is the one the fan first agreed to,
 * not necessarily today's document: changing the terms means a deliberate migration of
 * these columns, not something a sign-in does. A second call is a silent no-op: the caller
 * has nothing to repair, since the fan already consented.
 *
 * The timestamp comes from the database clock, not from the process. Two api instances with
 * skewed clocks would otherwise disagree about when the same fan accepted, and the stored
 * value has to line up with `fans.created_at` and the session rows written by the same
 * server.
 */
export async function recordTermsAcceptance(
  tx: Queryable,
  fanId: string,
  version: string,
): Promise<void> {
  await tx.query(
    `update fans
        set terms_version = $2, terms_accepted_at = now()
      where id = $1 and terms_accepted_at is null`,
    [fanId, version],
  )
}

/**
 * Moves the fan's last activity signal to now.
 *
 * Retention deletes accounts that have been inactive for long enough, and this timestamp is
 * that activity signal: every successful sign-in touches it, so an account in use is never
 * swept. It is written on every sign-in rather than only on the first one, because the point
 * is how recently the fan was here.
 *
 * As with the acceptance, `now()` is the database clock, so the value is comparable with
 * `created_at` on the same row and with the clocks of every other api instance.
 */
export async function touchLastSeen(tx: Queryable, fanId: string): Promise<void> {
  await tx.query('update fans set last_seen_at = now() where id = $1', [fanId])
}
