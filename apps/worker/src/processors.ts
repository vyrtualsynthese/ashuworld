import type { Pool } from 'pg'
import type { GameConfig } from '@ashuworld/gameconfig'
import {
  awardMonthly,
  awardOnce,
  ensureIdentity,
  monthKey,
  type Queryable,
} from '@ashuworld/ledger'
import { parseDiscoveryPayload, type ProviderName } from '@ashuworld/providers'

/**
 * How one provider event is applied.
 *
 * A processor writes only through the transaction it is handed: the worker opens that
 * transaction, so a processor that throws rolls back every write it made, and the event
 * stays queued for the next attempt. A processor must not commit, roll back or open a
 * savepoint of its own — it would move work outside the unit the worker can retry.
 */
export type Processor = (tx: Queryable, payload: unknown) => Promise<void>

/**
 * The processors this worker runs, keyed by provider.
 *
 * A provider that is absent is deliberately not routable: the claim only looks at
 * providers in this map, so an event from a provider nobody has written a processor for
 * waits in the table without being claimed and without its `attempts` moving.
 */
export type ProcessorMap = Map<ProviderName, Processor>

/**
 * The processor for `provider`, or a loud failure naming it.
 *
 * `processOne` claims only providers present in the map, so this cannot fail from there.
 * It exists so the lookup is checked once, in one place, instead of every caller asserting
 * that the SQL filter and the map keys agree.
 */
export function requireProcessor(processors: ProcessorMap, provider: string): Processor {
  const processor = processors.get(provider as ProviderName)
  if (processor === undefined) {
    throw new Error(`no processor is registered for provider "${provider}"`)
  }
  return processor
}

interface UnroutedRow {
  provider: string
  waiting: number
  oldest_id: string
}

/**
 * Warns once per provider that has queued events but no processor.
 *
 * Leaving those rows alone is the right behavior — claiming them would either count
 * attempts against an event no code can handle, or mark it processed and lose it — but
 * leaving them alone silently would look like an idle queue forever. `reported` is the
 * loop's memory: each provider is named once per process, so a queue that only holds
 * unroutable events does not print the same line every second.
 *
 * The warning names the oldest event and the count, which is what an operator needs to
 * decide whether a deployment is missing a processor or a platform is sending something
 * unexpected.
 */
export async function reportUnroutedProviders(
  pool: Pool,
  processors: ProcessorMap,
  reported: Set<string>,
): Promise<void> {
  const { rows } = await pool.query<UnroutedRow>(
    `select provider, count(*)::int as waiting, min(id)::text as oldest_id
       from inbound_events
      where processed_at is null
        and not (provider = any($1::text[]))
      group by provider
      order by min(id)`,
    [[...processors.keys()]],
  )

  for (const row of rows) {
    if (reported.has(row.provider)) continue
    reported.add(row.provider)
    console.warn(
      `[worker] ${row.waiting} event(s) from "${row.provider}" are waiting but no processor is registered; ` +
        `the oldest is #${row.oldest_id}. They are not claimed, so their attempts stay at 0.`,
    )
  }
}

/**
 * The discovery processor: one event about one person pays the actions it lists.
 *
 * Each action pays its one-time amount and the current month's credit. Both go through
 * the ledger's conflict-based guards, so a redelivered event, a connector that runs every
 * fifteen minutes and two workers racing the same payload all leave exactly one row per
 * action and month. That also means the processor needs no "have I seen this" state of
 * its own.
 *
 * A detached identity is skipped after its handle is refreshed. Someone who signed in,
 * unlinked and kept being followed is not a customer of the ladder any more: paying them
 * would build a balance nobody can spend and, worse, would resurrect it if they ever
 * linked again. `first_linked_at` is what distinguishes them from a person seen for the
 * first time — the link and detach rules own that column; this processor only reads it.
 *
 * An action the game config does not define throws, naming the key. The queue then keeps
 * the event unprocessed with its attempt counted, so a config typo is visible in the log
 * and retried after a deploy instead of paying nothing silently. The throw also rolls
 * back the identity upsert, keeping the failure all-or-nothing.
 *
 * `now` is injected so the month a test asserts on does not depend on the wall clock.
 */
export function createDiscoveryProcessor(
  cfg: GameConfig,
  now: () => Date = () => new Date(),
): Processor {
  return async (tx, raw) => {
    const payload = parseDiscoveryPayload(raw)
    const { id: identityId } = await ensureIdentity(tx, {
      provider: payload.provider,
      externalId: payload.externalId,
      displayHandle: payload.displayHandle,
      displayName: payload.displayName,
    })

    const { rows } = await tx.query<{ fan_id: string | null; first_linked_at: Date | null }>(
      `select fan_id, first_linked_at from provider_identities where id = $1`,
      [identityId],
    )
    const identity = rows[0]
    if (identity === undefined) throw new Error(`discovery: identity ${identityId} vanished`)
    if (identity.fan_id === null && identity.first_linked_at !== null) return

    for (const actionKey of payload.actions) {
      const action = cfg.actions[actionKey]
      if (action === undefined) {
        throw new Error(`discovery: game config has no action "${actionKey}"`)
      }
      await awardOnce(tx, {
        identityId,
        provider: payload.provider,
        actionKey,
        amount: action.amount,
        idempotencyKey: `discovery:${payload.provider}:${payload.externalId}:${actionKey}`,
        cfg,
      })
      await awardMonthly(tx, {
        identityId,
        provider: payload.provider,
        baseActionKey: actionKey,
        month: monthKey(now()),
        cfg,
      })
    }
  }
}

/**
 * The processors the worker registers, keyed by provider.
 *
 * Twitch and Discord share one discovery processor because the payload, not the platform,
 * says which actions to pay; only the connector that finds the person differs. YouTube is
 * deliberately absent: the game config prices `youtube.subscribe`, but no connector
 * reports YouTube people yet, so its events stay unclaimed rather than burning attempts
 * on an action nobody can satisfy.
 */
export function createProcessors(cfg: GameConfig): ProcessorMap {
  const discovery = createDiscoveryProcessor(cfg)
  return new Map<ProviderName, Processor>([
    ['twitch', discovery],
    ['discord', discovery],
  ])
}
