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

/** An identity a sign-in matched, and whether it matched through its anonymised pseudonym. */
export interface LoginIdentityRef extends IdentityRef {
  /**
   * True when the row's provider id is the peppered pseudonym `erasedExternalId` writes, not
   * the raw id the provider sends. It is the one authoritative answer to "was this account
   * erased", so no caller has to guess from the stored value's shape.
   */
  erased: boolean
}

/**
 * Sets the handle an identity displays from the provider's current profile.
 *
 * `ensureIdentity` refreshes it on its upsert, but a sign-in that matched an existing row
 * reads instead of upserting, so the refresh is a call of its own: a fan who renamed on the
 * provider sees the new name on their next login. Kept here so the api never writes the
 * table itself.
 */
export async function refreshIdentityHandle(
  tx: Queryable,
  identityId: string,
  displayHandle: string,
): Promise<void> {
  await tx.query('update provider_identities set display_handle = $2 where id = $1', [
    identityId,
    displayHandle,
  ])
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
 * The raw match must win, and it is also what the answer's `erased: false` means. A real
 * identity always carries a raw provider id, so a provider id that happens to begin with
 * `erased:` still resolves to the row that literally stores it rather than to a hash of
 * itself. One `or` over both values could not express that precedence.
 *
 * The pseudonym includes the provider name, so the same account id on two providers hashes
 * to two different values and a lookup never crosses providers.
 */
export async function findIdentityForLogin(
  tx: Queryable,
  input: { provider: ProviderName; externalId: string; pepper: string },
): Promise<LoginIdentityRef | null> {
  const raw = await tx.query<{ id: string }>(
    `select id
       from provider_identities
      where provider = $1
        and external_id = $2`,
    [input.provider, input.externalId],
  )
  const live = raw.rows[0]
  if (live !== undefined) return { id: live.id, erased: false }

  const pseudonym = erasedExternalId(input.pepper, input.provider, input.externalId)
  const erased = await tx.query<{ id: string }>(
    `select id
       from provider_identities
      where provider = $1
        and external_id = $2`,
    [input.provider, pseudonym],
  )
  const anonymised = erased.rows[0]
  return anonymised === undefined ? null : { id: anonymised.id, erased: true }
}
