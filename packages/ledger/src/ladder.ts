import type { ProviderName } from '@ashuworld/providers'
import type { Queryable } from './db.js'
import { getStanding, liveBalancesQuery } from './standing.js'

/** One account on the public ladder, ranked by what it can spend today. */
export interface LadderRow {
  fanId: string
  handle: string
  level: number
  balance: number
}

/**
 * One provider account that has never joined a fan account.
 *
 * Free-standing identities earned xp before anyone linked them, so they get their own
 * row instead of silently disappearing from the ladder until a login claims them.
 */
export interface FreeStandingRow {
  identityId: string
  provider: ProviderName
  displayHandle: string
  xp: number
}

/** A public profile: the account, its standing and the identities currently attached. */
export interface PublicFanProfile {
  id: string
  handle: string
  displayName: string
  level: number
  balance: number
  peakXp: number
  identities: Array<{ provider: ProviderName; displayHandle: string }>
}

/** What `listLadder` answers: the ranked accounts and the never-linked identities. */
export interface Ladder {
  linked: LadderRow[]
  freeStanding: FreeStandingRow[]
}

/**
 * The one definition of a free-standing identity: it belongs to no fan and has never
 * belonged to one.
 *
 * `first_linked_at` is never cleared, unlike `fan_id` and `linked_at`, so a detached
 * identity still fails this test. Keeping the predicate in one string is what stops a
 * later query (or a test) from writing `fan_id is null` alone and quietly putting a
 * once-linked account back on the public ladder — the exact regression the design forbids.
 */
const FREE_STANDING = 'i.fan_id is null and i.first_linked_at is null'

interface LinkedRow {
  fan_id: string
  handle: string
  level: number
  balance: number
}

interface FreeRow {
  identity_id: string
  provider: ProviderName
  display_handle: string
  xp: number
}

/**
 * The public ladder in two lists: fan accounts ranked by current balance, and identities
 * that have never been linked.
 *
 * `balance` comes from the same rule `computeBalance` uses, in its grouped form
 * (`liveBalancesQuery`), never from `fans.peak_xp`. The peak is a record that only moves
 * forward; ranking by it would put a punished or detached fan above someone who actually
 * has more xp to spend, and the ladder would disagree with the profile page it links to.
 *
 * Grouped rather than lateral on purpose. A `cross join lateral` runs the per-fan balance
 * once per row of `fans`, and its `or` over the two ownership branches cannot use an
 * index, so the planner rescans the whole ledger for every fan (measured: 26.5 s for
 * 2,000 fans over 102,000 entries). One aggregate over the table is 30 ms and lets the
 * penalty branch use `xp_entries_fan_live`.
 *
 * A fan who lost everything still belongs on the ladder: their balance is 0 and they sort
 * to the bottom, but they do not vanish because they had a bad month. Ties break by
 * handle so the order is stable between two requests that see the same snapshot.
 *
 * A free-standing identity appears only when it has an earn that has not been forfeited.
 * A row with 0 xp would be a placeholder, not a competitor; an identity that earned and
 * then detached has no live earn and, through `first_linked_at`, is excluded anyway.
 *
 * Callers that need both lists to describe one moment should read them in a repeatable-read
 * transaction: `withTransaction` alone runs each statement under its own READ COMMITTED
 * snapshot.
 */
export async function listLadder(tx: Queryable): Promise<Ladder> {
  const linked = await tx.query<LinkedRow>(
    `select f.id as fan_id, f.handle, f.level, coalesce(live.balance, 0) as balance
       from fans f
       left join (${liveBalancesQuery()}) live on live.fan_id = f.id
      order by coalesce(live.balance, 0) desc, f.handle asc`,
  )

  const free = await tx.query<FreeRow>(
    `select i.id as identity_id, i.provider, i.display_handle,
            sum(e.amount)::int as xp
       from provider_identities i
       join xp_entries e
         on e.identity_id = i.id
        and e.kind = 'earn'
        and e.forfeited_at is null
      where ${FREE_STANDING}
      group by i.id, i.provider, i.display_handle
      order by xp desc, i.display_handle asc, i.id asc`,
  )

  return {
    linked: linked.rows.map((row) => ({
      fanId: row.fan_id,
      handle: row.handle,
      level: row.level,
      balance: row.balance,
    })),
    freeStanding: free.rows.map((row) => ({
      identityId: row.identity_id,
      provider: row.provider,
      displayHandle: row.display_handle,
      xp: row.xp,
    })),
  }
}

interface FanRow {
  id: string
  handle: string
  display_name: string
}

interface AccountIdentityRow {
  provider: ProviderName
  display_handle: string
}

/**
 * The public profile behind a handle, or `null` when no account has it.
 *
 * `null` rather than a thrown error because an unknown handle is an ordinary answer: the
 * route turns it into the shared 404 without inventing an error type. Nothing here needs
 * to know whether the caller is signed in.
 *
 * The handle is normalised before the select. Storage is already lowercase (the schema's
 * check allows nothing else), so a path segment typed as `Ashu` still finds the account
 * while the comparison stays exact rather than relying on `ilike`.
 *
 * Only identities with both a `fan_id` and a `linked_at` are listed: that is the same
 * attachment rule the balance uses, so the profile cannot show an identity whose xp it is
 * not counting. `external_id` is never selected — it is the provider's account id, and a
 * public page has no reason to know it.
 */
export async function getFanByHandle(
  tx: Queryable,
  handle: string,
): Promise<PublicFanProfile | null> {
  const normalised = handle.trim().toLowerCase()
  const { rows } = await tx.query<FanRow>(
    `select id, handle, display_name
       from fans
      where handle = $1`,
    [normalised],
  )
  const fan = rows[0]
  if (fan === undefined) return null

  const standing = await getStanding(tx, fan.id)
  const identities = await tx.query<AccountIdentityRow>(
    `select provider, display_handle
       from provider_identities
      where fan_id = $1
        and linked_at is not null
      order by provider, display_handle, id`,
    [fan.id],
  )

  return {
    id: fan.id,
    handle: fan.handle,
    displayName: fan.display_name,
    level: standing.level,
    balance: standing.balance,
    peakXp: standing.peakXp,
    identities: identities.rows.map((identity) => ({
      provider: identity.provider,
      displayHandle: identity.display_handle,
    })),
  }
}
