import type { IdentityProfile, ProviderName } from '@ashuworld/providers'
import type { Queryable } from './db.js'
import { erasedExternalId } from './privacy.js'

/** The ledger's handle on one provider account. */
export interface IdentityRef {
  id: string
}

/**
 * Resolves a provider account to its `provider_identities` row, creating it on first
 * sight.
 *
 * One statement, so a re-follow, a re-link and two deliveries of the same event cannot
 * race to insert twice: the unique `(provider, external_id)` makes the second caller wait
 * and then take the update branch. The update writes `display_handle` only, which keeps
 * the fan link, `linked_at` and `first_linked_at` untouched across a rename — those are
 * owned by the link and detach rules, not by a profile refresh.
 *
 * `displayName` is deliberately not stored here: `provider_identities` has no
 * `display_name` column, and the account's display name belongs to `fans`, written when
 * the account is created.
 */
export async function ensureIdentity(tx: Queryable, profile: IdentityProfile): Promise<IdentityRef> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into provider_identities (provider, external_id, display_handle)
     values ($1, $2, $3)
     on conflict (provider, external_id) do update
       set display_handle = excluded.display_handle
     returning id`,
    [profile.provider, profile.externalId, profile.displayHandle],
  )
  const row = rows[0]
  if (row === undefined) {
    // `on conflict do update ... returning` hands back a row for every insert, so an
    // empty result means the conflicting row was deleted while this call waited for it.
    // Fail closed: an identity the caller cannot name is worse than an error.
    throw new Error(`ensureIdentity: ${profile.provider} identity ${profile.externalId} returned no row`)
  }
  return { id: row.id }
}

/**
 * The identity a provider account already owns, erased or not. Read-only: nothing here
 * inserts or updates, so a sign-in that finds nothing is free to create the row.
 *
 * Two lookups, in this order, because they mean different things:
 *
 * 1. the raw `(provider, external_id)` — a live identity stores exactly what the provider
 *    sends, so this is the ordinary returning fan;
 * 2. the peppered pseudonym `erasedExternalId` computes — an erased identity keeps its row
 *    (its one-time earn keys must survive) but its provider id is replaced by that hash.
 *    Without this second lookup, the same person signing in again would look like a
 *    stranger, get a second identity row and collect the welcome bonus twice.
 *
 * The raw match must win. A real identity always carries a raw provider id, and only an
 * erased one carries the `erased:` pseudonym, so a provider id that happens to look like a
 * pseudonym still resolves to the row that literally stores it rather than to a hash of
 * itself. One `or` over both values could not express that precedence.
 */
export async function findIdentityForLogin(
  tx: Queryable,
  input: { provider: ProviderName; externalId: string; pepper: string },
): Promise<IdentityRef | null> {
  const raw = await tx.query<{ id: string }>(
    `select id
       from provider_identities
      where provider = $1
        and external_id = $2`,
    [input.provider, input.externalId],
  )
  const live = raw.rows[0]
  if (live !== undefined) return { id: live.id }

  const pseudonym = erasedExternalId(input.pepper, input.provider, input.externalId)
  const erased = await tx.query<{ id: string }>(
    `select id
       from provider_identities
      where provider = $1
        and external_id = $2`,
    [input.provider, pseudonym],
  )
  const anonymised = erased.rows[0]
  return anonymised === undefined ? null : { id: anonymised.id }
}
