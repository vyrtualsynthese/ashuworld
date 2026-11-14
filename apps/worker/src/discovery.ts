import type { DiscoveredPerson } from '@ashuworld/providers'
import type { Connector } from './connectors/types.js'

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
 * broken source must not suspend discovery from the others. The people it already yielded
 * before failing are enqueued, because `enqueue` is idempotent by event id — the next round
 * re-affirms them.
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
      try {
        for await (const person of connector.discover()) {
          await enqueue(person)
        }
      } catch (error) {
        console.error(
          `[worker] connector "${connector.name}" failed during discovery; ` +
            'the other connectors keep running and this one retries next round',
          error,
        )
      }
    }
    await wait(intervalMs, signal)
  }
}
