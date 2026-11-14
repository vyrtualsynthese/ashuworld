import { createHmac } from 'node:crypto'
import type { Pool } from 'pg'
import type { ProviderName } from '@ashuworld/providers'
import { requireTransaction, withTransaction, type Queryable } from './db.js'
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

/**
 * How long an untouched account is kept before its personal data is erased.
 *
 * Three years: long enough that a fan who steps away for a season still finds their
 * history, short enough that an abandoned account does not outlive its purpose.
 */
export const INACTIVE_FAN_RETENTION_DAYS = 1095

/**
 * How long a provider account that never joined a fan account is kept.
 *
 * Same three years as an inactive fan, because it is the same personal data: a provider
 * display handle and the id behind it. There is no fan to ask, so the clock starts at the
 * row's creation rather than at a sign-in that never happened.
 */
export const NEVER_LINKED_IDENTITY_RETENTION_DAYS = 1095

/**
 * How long a processed provider event is kept.
 *
 * The payload is the raw webhook body — the most personal thing the ledger stores — and
 * its only use is a replay within a day or two. Thirty days keeps a fortnight of incident
 * investigation while the delivery receipts age out quickly.
 */
export const PROCESSED_EVENT_RETENTION_DAYS = 30

/** How long the audit trail is kept, counted from the moment the row was written. */
export const AUDIT_RETENTION_DAYS = 1095

/** What one purge pass removed. Counts only, in the same spirit as the erasure results. */
export interface PurgeResult {
  /** Accounts passed through `eraseFan`. */
  fans: number
  /** Never-linked identities passed through `eraseIdentity`. */
  identities: number
  /** Processed provider events deleted. */
  events: number
  /** Audit rows deleted. */
  audit: number
}

const MS_PER_DAY = 86_400_000

/** The cutoff for a retention window, derived from the caller's clock rather than the database's. */
function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_PER_DAY)
}

// One definition per predicate, so the counting read and the deleting write can never
// disagree about which rows a pass covers.
const PROCESSED_EVENT_PURGE = 'processed_at is not null and received_at < $1'
const AUDIT_PURGE = 'created_at < $1'

async function countRows(tx: Queryable, sql: string, values: unknown[]): Promise<number> {
  const { rows } = await tx.query<{ count: number }>(sql, values)
  return rows[0]?.count ?? 0
}

/**
 * One retention pass: delete what is past its window, erase what belongs to nobody.
 *
 * A single transaction, so a pass either moves every row it reports or none of them. The
 * caller gets counts, and running the same pass twice is safe: the first one marks the
 * fans erased, hashes the identities and deletes the events and audit rows, and the
 * second selects nothing.
 *
 * The clock is a bound parameter (`input.now`, defaulting to the process clock) and never
 * SQL `now()`, so a retention window is decided once, in one place, and a test can move
 * the date without waiting three years.
 *
 * Order matters for one reason: audit rows are deleted before the erasures run, so the
 * `erase` rows this pass writes are fresh and survive to describe what happened. Erasing
 * first and pruning afterwards would delete the record of the work in the same pass that
 * did it.
 *
 * `dryRun` runs the same selections and the same counts but calls neither `eraseFan` nor
 * `eraseIdentity` and deletes nothing, which is what makes it usable as a preview against
 * production.
 *
 * `limit` caps each of the two erasure passes separately (not the deletions, which are one
 * statement each): a first run on a large backlog stays bounded, and the next pass picks
 * up where this one stopped because the rows it handled no longer match.
 */
export async function purgeBatch(
  pool: Pool,
  input: { pepper: string; dryRun: boolean; now?: Date; limit?: number },
): Promise<PurgeResult> {
  const now = input.now ?? new Date()
  const limit = input.limit ?? 100
  const eventCutoff = daysBefore(now, PROCESSED_EVENT_RETENTION_DAYS)
  const auditCutoff = daysBefore(now, AUDIT_RETENTION_DAYS)
  const fanCutoff = daysBefore(now, INACTIVE_FAN_RETENTION_DAYS)
  const identityCutoff = daysBefore(now, NEVER_LINKED_IDENTITY_RETENTION_DAYS)

  return withTransaction(pool, async (tx) => {
    const events = input.dryRun
      ? await countRows(
          tx,
          `select count(*)::int as count from inbound_events where ${PROCESSED_EVENT_PURGE}`,
          [eventCutoff],
        )
      : (
          await tx.query<{ id: string }>(
            `delete from inbound_events where ${PROCESSED_EVENT_PURGE} returning id`,
            [eventCutoff],
          )
        ).rows.length

    const audit = input.dryRun
      ? await countRows(
          tx,
          `select count(*)::int as count from audit_log where ${AUDIT_PURGE}`,
          [auditCutoff],
        )
      : (
          await tx.query<{ id: string }>(`delete from audit_log where ${AUDIT_PURGE} returning id`, [
            auditCutoff,
          ])
        ).rows.length

    // `coalesce(last_seen_at, created_at)` is the same activity signal the partial index
    // `fans_inactive` covers: the last sign-in, or creation for an account never seen
    // since. An erased account is never a candidate, and the index skips it.
    const inactive = await tx.query<{ id: string }>(
      `select id
         from fans
        where erased_at is null
          and coalesce(last_seen_at, created_at) < $1
        order by coalesce(last_seen_at, created_at), id
        limit $2::int`,
      [fanCutoff, limit],
    )

    // `fan_id is null` mirrors the free-standing rule. An attached identity is erased
    // through its fan, and `eraseIdentity` refuses one; without this guard a single
    // inconsistent row would abort the whole pass.
    const neverLinked = await tx.query<{ id: string }>(
      `select id
         from provider_identities
        where fan_id is null
          and first_linked_at is null
          and external_id not like 'erased:%'
          and created_at < $1
        order by created_at, id
        limit $2::int`,
      [identityCutoff, limit],
    )

    if (!input.dryRun) {
      for (const fan of inactive.rows) {
        await eraseFan(tx, { fanId: fan.id, pepper: input.pepper })
      }
      for (const identity of neverLinked.rows) {
        await eraseIdentity(tx, { identityId: identity.id, pepper: input.pepper })
      }
    }

    return {
      fans: inactive.rows.length,
      identities: neverLinked.rows.length,
      events,
      audit,
    }
  })
}
