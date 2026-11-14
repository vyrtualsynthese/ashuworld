import type { GameConfig } from '@ashuworld/gameconfig'
import { isUniqueViolation, type Queryable } from './db.js'
import { recomputeStanding } from './standing.js'

/** What a link attempt did, or why it did nothing. */
export type LinkResult = { ok: true } | { ok: false; reason: 'already_owned' | 'same_provider' }

/** What a detach did, or why it did nothing. */
export type DetachResult =
  | { ok: true; forfeitedEntries: number }
  | { ok: false; reason: 'not_attached' | 'last_identity' }

/** The fields both account changes need: who acts, on which identity, under which rules. */
export interface IdentityChangeInput {
  fanId: string
  identityId: string
  cfg: GameConfig
}

/**
 * Refuses a caller that passed a bare pool instead of an open transaction.
 *
 * Both account changes depend on statement lifetime: a `for update` lock is held until the
 * transaction ends, and the savepoint that turns a unique violation back into a refusal
 * only exists inside one. On a bare pool each statement autocommits on whichever
 * connection the pool hands out — so `detachIdentity` would release its fan lock before
 * the count is even decided, and two concurrent detaches could each unlink one of the
 * fan's two identities, leaving the zero-identity account the rule forbids. A failure
 * halfway through would also leave the forfeit committed without the unlink.
 *
 * Postgres rejects `savepoint` outside a transaction block ("SAVEPOINT can only be used in
 * transaction blocks"), so this pair is the cheapest enforcement the database offers. It
 * costs two round trips inside a real transaction.
 */
async function requireTransaction(tx: Queryable): Promise<void> {
  await tx.query('savepoint ledger_tx_required')
  await tx.query('release savepoint ledger_tx_required')
}

/**
 * Attaches a provider identity to a fan, unless the identity is somebody else's or the fan
 * already holds that provider.
 *
 * Must run inside a transaction (`withTransaction`): the row lock and the savepoint below
 * only exist for the length of one.
 *
 * The identity row is locked before anything is checked, so two fans linking the same
 * identity cannot both read `fan_id is null` and both write: the second caller waits on
 * the lock, then sees the first fan's committed link and answers `already_owned`. The
 * unique `(provider, external_id)` index is not enough on its own — it would let both
 * writes succeed in sequence, with the last one silently stealing the identity.
 *
 * `first_linked_at` is stamped with `coalesce`, so the first attach sets it and every
 * later attach leaves it alone. That column is never cleared, which is what keeps the
 * identity off the free-standing ladder for good.
 *
 * The same-provider check is a read, so two identities of one provider linked at the same
 * moment can both pass it. The unique `(fan_id, provider)` index refuses the second write;
 * the savepoint turns that refusal back into `same_provider` and leaves the caller's
 * transaction usable, instead of surfacing a raw unique violation.
 *
 * The first statements are a savepoint pair that exists only to refuse a bare pool. See
 * `requireTransaction` below: documentation alone is not enough, because the damage from
 * running outside a transaction is silent.
 */
export async function linkIdentity(
  tx: Queryable,
  input: IdentityChangeInput,
): Promise<LinkResult> {
  await requireTransaction(tx)

  const locked = await tx.query<{ fan_id: string | null; provider: string }>(
    `select fan_id, provider
       from provider_identities
      where id = $1
      for update`,
    [input.identityId],
  )
  const identity = locked.rows[0]
  if (identity === undefined) {
    // There is no row to attach, and the result type has no reason for that: inventing
    // `already_owned` would tell the caller an identity exists when it does not.
    throw new Error(`linkIdentity: no provider_identities row for ${input.identityId}`)
  }

  if (identity.fan_id !== null && identity.fan_id !== input.fanId) {
    return { ok: false, reason: 'already_owned' }
  }

  // A link by the fan that already owns the identity lands here too: the fan holds that
  // provider, and a second identity of one provider is exactly what this rule refuses.
  const held = await tx.query<{ id: string }>(
    `select id from provider_identities where fan_id = $1 and provider = $2 limit 1`,
    [input.fanId, identity.provider],
  )
  if (held.rows[0] !== undefined) return { ok: false, reason: 'same_provider' }

  await tx.query('savepoint link_identity')
  try {
    await tx.query(
      `update provider_identities
          set fan_id = $1,
              linked_at = now(),
              first_linked_at = coalesce(first_linked_at, now())
        where id = $2`,
      [input.fanId, input.identityId],
    )
  } catch (error) {
    if (!isUniqueViolation(error, 'provider_identities_fan_id_provider_key')) throw error
    // The competing link committed while this one was waiting on the index. Returning
    // from an aborted transaction would fail at commit, so undo the failed statement
    // first, then report the refusal the caller can act on. The savepoint is released
    // rather than left defined, so the caller's transaction does not carry a subtransaction
    // until commit.
    await tx.query('rollback to savepoint link_identity')
    await tx.query('release savepoint link_identity')
    return { ok: false, reason: 'same_provider' }
  }
  await tx.query('release savepoint link_identity')

  await tx.query(
    `insert into audit_log (kind, fan_id, identity_id, actor_fan_id, detail)
     values ('link', $1, $2, $1, '{}'::jsonb)`,
    [input.fanId, input.identityId],
  )

  // The identity may have earned before it was ever linked; those earns start counting
  // for the fan now, so the standing has to be brought up to date in the same transaction.
  await recomputeStanding(tx, input.fanId, input.cfg)
  return { ok: true }
}

/**
 * Detaches an identity from its fan and forfeits that identity's earns.
 *
 * Must run inside a transaction, and `requireTransaction` enforces it: the fan lock is only
 * meaningful for the length of one transaction.
 *
 * The fan row is locked first and the count happens after the lock. Counting first is the
 * trap: two detaches of the same fan's two identities would each count two, each detach
 * one, and leave an account nobody can log into. With the fan lock, the second detach
 * waits, then counts one and answers `last_identity`.
 *
 * The forfeit marks the identity's live earns; nothing is deleted. Deleting the rows would
 * take the one-time action keys with them, and the same follow could be paid again after a
 * re-link. `first_linked_at` is left in place for the same kind of reason: the identity
 * keeps its history even while it has no fan.
 */
export async function detachIdentity(
  tx: Queryable,
  input: IdentityChangeInput,
): Promise<DetachResult> {
  await requireTransaction(tx)

  const fan = await tx.query<{ id: string }>('select id from fans where id = $1 for update', [
    input.fanId,
  ])
  if (fan.rows[0] === undefined) {
    throw new Error(`detachIdentity: no fans row for ${input.fanId}`)
  }

  const locked = await tx.query<{ fan_id: string | null }>(
    'select fan_id from provider_identities where id = $1 for update',
    [input.identityId],
  )
  const identity = locked.rows[0]
  if (identity === undefined) {
    throw new Error(`detachIdentity: no provider_identities row for ${input.identityId}`)
  }
  if (identity.fan_id !== input.fanId) return { ok: false, reason: 'not_attached' }

  // `linked_at is not null` matches the balance rule in `standing.ts`: an identity with a
  // fan id but no link is not paying into the account, so it cannot be the one the fan
  // keeps.
  const counted = await tx.query<{ attached: number }>(
    `select count(*)::int as attached
       from provider_identities
      where fan_id = $1 and linked_at is not null`,
    [input.fanId],
  )
  const attached = counted.rows[0]?.attached ?? 0
  if (attached <= 1) return { ok: false, reason: 'last_identity' }

  const forfeited = await tx.query<{ id: string }>(
    `update xp_entries
        set forfeited_at = now()
      where identity_id = $1
        and kind = 'earn'
        and forfeited_at is null
      returning id`,
    [input.identityId],
  )

  await tx.query(
    `update provider_identities
        set fan_id = null,
            linked_at = null
      where id = $1`,
    [input.identityId],
  )

  await tx.query(
    `insert into audit_log (kind, fan_id, identity_id, actor_fan_id, detail)
     values ('detach', $1, $2, $1, jsonb_build_object('forfeitedEntries', $3::int))`,
    [input.fanId, input.identityId, forfeited.rows.length],
  )

  await recomputeStanding(tx, input.fanId, input.cfg)
  return { ok: true, forfeitedEntries: forfeited.rows.length }
}
