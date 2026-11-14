import type { IdentityProfile } from '@ashuworld/providers'
import type { Queryable } from './db.js'

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
