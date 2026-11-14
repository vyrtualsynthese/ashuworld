import { createHmac } from 'node:crypto'
import type { ProviderName } from '@ashuworld/providers'
import { requireTransaction, type Queryable } from './db.js'
import { getStanding } from './standing.js'

/** The environment variable the erasure CLI and the sweeper read the pepper from. */
export const ERASURE_PEPPER_ENV = 'ERASURE_PEPPER'

/**
 * The irreversible stand-in for a provider account id.
 *
 * A plain hash is not enough: provider ids are short and guessable (a numeric Twitch id, a
 * YouTube channel id), so an attacker holding the table could hash every candidate and
 * match rows. The pepper is the secret that makes that dictionary useless, which is why it
 * comes from configuration and never from the database.
 *
 * The provider name is part of the message so the same account id on two providers does
 * not produce one shared value. The `erased:` prefix marks the value as anonymised, which
 * is what keeps an erased identity off the free-standing ladder.
 */
export function erasedExternalId(pepper: string, provider: string, externalId: string): string {
  const digest = createHmac('sha256', pepper).update(`${provider}:${externalId}`).digest('hex')
  return `erased:${digest}`
}

/** What an account erasure did, in counts only: nothing here can name the person again. */
export interface EraseFanResult {
  /** Identities detached and anonymised. */
  identities: number
  /** Live earns marked forfeited. The rows themselves are kept. */
  forfeitedEntries: number
}

/** What a never-linked identity erasure did. */
export interface EraseIdentityResult {
  /** Live earns marked forfeited. The rows themselves are kept. */
  forfeitedEntries: number
}

/** No `provider_identities` row has this id. */
export class IdentityNotFoundError extends Error {
  readonly identityId: string

  constructor(identityId: string) {
    super(`eraseIdentity: no provider_identities row for ${identityId}`)
    this.name = 'IdentityNotFoundError'
    this.identityId = identityId
  }
}

/**
 * The identity still belongs to an account.
 *
 * An attached identity is erased through `eraseFan`, which can anonymise the account, its
 * sessions and all of its identities in one transaction. Erasing the identity alone would
 * leave the fan pointing at a row whose provider id no longer exists, so the two commands
 * would disagree about what an erased account looks like.
 */
export class IdentityAttachedError extends Error {
  readonly identityId: string
  readonly fanId: string

  constructor(identityId: string, fanId: string) {
    super(
      `eraseIdentity: identity ${identityId} is still attached to fan ${fanId}; erase the account instead`,
    )
    this.name = 'IdentityAttachedError'
    this.identityId = identityId
    this.fanId = fanId
  }
}

/**
 * Anonymises an account in place: the rows stay, the person is gone.
 *
 * Must run inside a transaction (`withTransaction`), and `requireTransaction` enforces it.
 * A failure halfway through — after the identities are detached but before the earns are
 * forfeited — would otherwise be committed piece by piece on a bare pool, leaving a
 * half-erased account that neither the ladder nor the retention sweep could reason about.
 *
 * What survives, and why:
 *
 * - the fan row, with a random `deleted_…` handle, a neutral display name and `erased_at`
 *   set. Deleting it would leave every `xp_entries.fan_id` and `audit_log.fan_id` pointing
 *   at nothing;
 * - every xp entry, forfeited rather than deleted. The one-time `(identity_id, action_key)`
 *   key lives on the earn row, so deleting it would let the same follow pay again after a
 *   re-link;
 * - `first_linked_at` on each identity. It is the mark that keeps a once-linked identity off
 *   the free-standing ladder, which is the only history erasure does not clear.
 *
 * The identity's provider id is replaced by a peppered hash, so the row can still be
 * recognised as the same provider account (a re-link finds it by hash only if someone
 * knows the raw id and the pepper) without storing what it was. `linked_at` is cleared but
 * `first_linked_at` is deliberately not touched.
 *
 * A second call is a no-op: the `erased_at is null` guard makes the anonymising update
 * match no row, and the function returns zeros without writing a second audit row.
 *
 * The audit row carries counts only and no fan, identity or actor id. An audit trail that
 * named the erased account would put the personal data back into a table built to outlive
 * it.
 */
export async function eraseFan(
  tx: Queryable,
  input: { fanId: string; pepper: string },
): Promise<EraseFanResult> {
  await requireTransaction(tx)

  const erased = await tx.query<{ id: string }>(
    `update fans
        set handle = 'deleted_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
            display_name = 'Compte supprimé',
            erased_at = now()
      where id = $1
        and erased_at is null
      returning id`,
    [input.fanId],
  )

  if (erased.rows[0] === undefined) {
    const existing = await tx.query<{ erased_at: Date | null }>(
      'select erased_at from fans where id = $1',
      [input.fanId],
    )
    const fan = existing.rows[0]
    if (fan === undefined) throw new Error(`eraseFan: no fans row for ${input.fanId}`)
    // Already erased: the work is done, and doing it again would write a second audit row.
    return { identities: 0, forfeitedEntries: 0 }
  }

  const identities = await tx.query<{ id: string; provider: string; external_id: string }>(
    `select id, provider, external_id
       from provider_identities
      where fan_id = $1
      for update`,
    [input.fanId],
  )

  for (const identity of identities.rows) {
    await tx.query(
      `update provider_identities
          set external_id = $2,
              display_handle = 'Compte supprimé',
              fan_id = null,
              linked_at = null
        where id = $1`,
      [identity.id, erasedExternalId(input.pepper, identity.provider, identity.external_id)],
    )
  }

  const identityIds = identities.rows.map((identity) => identity.id)
  let forfeitedEntries = 0
  if (identityIds.length > 0) {
    const forfeited = await tx.query<{ id: string }>(
      `update xp_entries
          set forfeited_at = now()
        where identity_id = any($1::uuid[])
          and kind = 'earn'
          and forfeited_at is null
        returning id`,
      [identityIds],
    )
    forfeitedEntries = forfeited.rows.length
  }

  await tx.query('delete from sessions where fan_id = $1', [input.fanId])

  await tx.query(
    `insert into audit_log (kind, fan_id, identity_id, actor_fan_id, detail)
     values ('erase', null, null, null,
             jsonb_build_object('identities', $1::int, 'forfeitedEntries', $2::int))`,
    [identities.rows.length, forfeitedEntries],
  )

  return { identities: identities.rows.length, forfeitedEntries }
}

/**
 * Anonymises one identity that never joined an account.
 *
 * The provider id and the display handle are personal data whether or not anybody claimed
 * the account, so a never-linked identity left alone forever would be a retention hole.
 * There is no fan row to mark and no session to delete; the earns are forfeited and kept
 * for the same one-time-key reason as in `eraseFan`.
 *
 * The row is locked before it is read, so two concurrent erasures cannot both hash the raw
 * id: the second waits, then hashes the already-erased value, which produces another
 * harmless ciphertext rather than resurrecting anything.
 */
export async function eraseIdentity(
  tx: Queryable,
  input: { identityId: string; pepper: string },
): Promise<EraseIdentityResult> {
  await requireTransaction(tx)

  const locked = await tx.query<{ fan_id: string | null; provider: string; external_id: string }>(
    `select fan_id, provider, external_id
       from provider_identities
      where id = $1
      for update`,
    [input.identityId],
  )
  const identity = locked.rows[0]
  if (identity === undefined) throw new IdentityNotFoundError(input.identityId)
  if (identity.fan_id !== null) throw new IdentityAttachedError(input.identityId, identity.fan_id)

  await tx.query(
    `update provider_identities
        set external_id = $2,
            display_handle = 'Compte supprimé'
      where id = $1`,
    [input.identityId, erasedExternalId(input.pepper, identity.provider, identity.external_id)],
  )

  const forfeited = await tx.query<{ id: string }>(
    `update xp_entries
        set forfeited_at = now()
      where identity_id = $1
        and kind = 'earn'
        and forfeited_at is null
      returning id`,
    [input.identityId],
  )

  return { forfeitedEntries: forfeited.rows.length }
}

/** One provider account on an exported profile. The provider id itself is not included. */
export interface ExportIdentity {
  provider: ProviderName
  displayHandle: string
  linkedAt: Date | null
}

/** One ledger row in an export, forfeited or not: the fan's history is theirs to receive. */
export interface ExportEntry {
  id: string
  provider: ProviderName
  actionKey: string
  amount: number
  kind: 'earn' | 'penalty'
  reason: string | null
  createdAt: Date
  forfeitedAt: Date | null
}

/** Everything the ledger holds about one active account, in one answer. */
export interface FanExport {
  handle: string
  displayName: string
  level: number
  balance: number
  peakXp: number
  identities: ExportIdentity[]
  entries: ExportEntry[]
}

interface ExportFanRow {
  id: string
  handle: string
  display_name: string
}

interface ExportIdentityRow {
  provider: ProviderName
  display_handle: string
  linked_at: Date | null
}

interface ExportEntryRow {
  id: string
  provider: ProviderName
  action_key: string
  amount: number
  kind: 'earn' | 'penalty'
  reason: string | null
  created_at: Date
  forfeited_at: Date | null
}

/**
 * The ledger's copy of one account, for the person who owns it.
 *
 * `null` for an unknown handle and for an erased one: an erased account has no person left
 * to export, and answering with its neutered row would suggest the data is still there.
 * The handle is normalised the same way `getFanByHandle` does, so a typed `Ashu` still
 * finds the account.
 *
 * Entries are read through both ownership paths, because a penalty belongs to the fan
 * (`fan_id`) while an earn belongs to an identity that may since have detached. Forfeited
 * earns are included: erasure and detach forfeit rows rather than delete them, and an
 * export that hid them would not be the account's complete history.
 */
export async function exportFan(tx: Queryable, handle: string): Promise<FanExport | null> {
  const normalised = handle.trim().toLowerCase()
  const { rows } = await tx.query<ExportFanRow>(
    `select id, handle, display_name
       from fans
      where handle = $1
        and erased_at is null`,
    [normalised],
  )
  const fan = rows[0]
  if (fan === undefined) return null

  const standing = await getStanding(tx, fan.id)

  const identities = await tx.query<ExportIdentityRow>(
    `select provider, display_handle, linked_at
       from provider_identities
      where fan_id = $1
        and linked_at is not null
      order by provider, display_handle, id`,
    [fan.id],
  )

  const entries = await tx.query<ExportEntryRow>(
    `select e.id, e.provider, e.action_key, e.amount, e.kind, e.reason,
            e.created_at, e.forfeited_at
       from xp_entries e
       left join provider_identities i on i.id = e.identity_id
      where e.fan_id = $1 or i.fan_id = $1
      order by e.created_at, e.id`,
    [fan.id],
  )

  return {
    handle: fan.handle,
    displayName: fan.display_name,
    level: standing.level,
    balance: standing.balance,
    peakXp: standing.peakXp,
    identities: identities.rows.map((identity) => ({
      provider: identity.provider,
      displayHandle: identity.display_handle,
      linkedAt: identity.linked_at,
    })),
    entries: entries.rows.map((entry) => ({
      id: entry.id,
      provider: entry.provider,
      actionKey: entry.action_key,
      amount: entry.amount,
      kind: entry.kind,
      reason: entry.reason,
      createdAt: entry.created_at,
      forfeitedAt: entry.forfeited_at,
    })),
  }
}
