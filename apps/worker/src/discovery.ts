import type { Pool } from 'pg'
import { enqueueEvent, monthKey } from '@ashuworld/ledger'
import { discoveryEventId, type DiscoveredPerson } from '@ashuworld/providers'
import type { Connector } from './connectors/types.js'

/**
 * The queue write a discovery round performs: one person becomes one `inbound_events`
 * row for the drain loop to pick up.
 *
 * The event id carries the source, the person, the actions and the month, so a person
 * seen again in the same month is the same event (the insert is a no-op) and a new month
 * is a new one. Building it here, next to the runner, keeps the key format out of the CLI
 * and lets a test call the builder without starting the loops.
 *
 * `now` is injected so the month a test asserts on does not depend on the wall clock.
 */
export function createDiscoveryEnqueue(
  pool: Pool,
  now: () => Date = () => new Date(),
): (person: DiscoveredPerson) => Promise<void> {
  return async (person) => {
    const month = monthKey(now())
    await enqueueEvent(pool, {
      provider: person.provider,
      eventId: discoveryEventId('sync', person, month),
      payload: { kind: 'discovery', ...person },
    })
  }
}

export interface DiscoveryRunnerOptions {
  connectors: Connector[]
  enqueue: (person: DiscoveredPerson) => Promise<void>
  intervalMs: number
  signal?: AbortSignal
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Resolves after `ms`, or as soon as `signal` fires.
 *
 * The `aborted` check before the timer matters for shutdown: a signal that arrived while a
 * connector was failing must end discovery immediately, not after one more full interval.
 */
function waitForSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const finish = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Runs every connector once per round, passes each person to `enqueue`, and waits
 * `intervalMs` between rounds until `signal` fires.
 *
 * One connector's failure is logged with its name and does not stop the round: a single
 * broken source must not suspend discovery from the others. The people it yielded before
 * failing are still enqueued, because they are collected before the failure is handled
 * and `enqueue` is idempotent by event id — the next round re-affirms them.
 *
 * An enqueue failure gets its own message and does not end the round either. It is a
 * different fault from a broken source (the database or the queue, not the connector),
 * so logging it as a connector failure would send an operator looking at the wrong
 * system. The person stays unqueued until the next round re-affirms them.
 *
 * An empty connector list returns at once. There is nothing to discover and no reason to
 * keep the interval timer alive.
 *
 * This function schedules only. It does not know how a person becomes a queue row, which is
 * what lets the same runner serve the current sync and the later per-source schedules.
 */
export async function runDiscovery(options: DiscoveryRunnerOptions): Promise<void> {
  const { connectors, enqueue, intervalMs, signal } = options
  const wait = options.wait ?? waitForSignal

  if (connectors.length === 0) return

  while (signal?.aborted !== true) {
    for (const connector of connectors) {
      // Collected per connector so `enqueue` sits outside the connector's `try`: a
      // failure there must not be reported as a source failure. The list is one round of
      // one source, which every current connector produces as a finite list anyway.
      const people: DiscoveredPerson[] = []
      try {
        for await (const person of connector.discover()) people.push(person)
      } catch (error) {
        console.error(
          `[worker] connector "${connector.name}" failed during discovery; ` +
            'the other connectors keep running and this one retries next round',
          error,
        )
      }

      for (const person of people) {
        try {
          await enqueue(person)
        } catch (error) {
          console.error(
            '[worker] discovery enqueue failed; the person stays unqueued for now and ' +
              'the next round re-affirms them',
            error,
          )
        }
      }
    }
    await wait(intervalMs, signal)
  }
}
