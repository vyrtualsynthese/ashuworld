import type { Pool } from 'pg'
import type { Queryable } from '@ashuworld/ledger'
import type { ProviderName } from '@ashuworld/providers'

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
