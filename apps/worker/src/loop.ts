import type { Pool } from 'pg'
import { withTransaction } from '@ashuworld/ledger'
import { reportUnroutedProviders, requireProcessor, type ProcessorMap } from './processors.js'

/**
 * What one poll did.
 *
 * `duplicate` belongs to the contract for a row a concurrent worker already processed.
 * With the claim below it cannot occur — `for update skip locked` never hands out a row
 * that is locked, and a processed row no longer matches the `processed_at is null` filter
 * — but the loop treats it like `processed` so a future claim that can observe it does not
 * silently stall.
 */
export type ProcessOutcome = 'processed' | 'duplicate' | 'empty'

/** The pause between polls whenever there was nothing to claim. */
export const DEFAULT_INTERVAL_MS = 1000

/**
 * The number of failed attempts after which a poison event drops out of the claim and
 * stays in the table for the operator.
 *
 * It is the upper bound in the claim SQL, so raising it delays the point where a bad
 * event stops blocking its provider's queue, and lowering it parks a flaky event sooner.
 */
export const MAX_EVENT_ATTEMPTS = 5

interface ClaimedEvent {
  id: string
  provider: string
  event_id: string
  payload: unknown
}

/**
 * Counts a failed attempt in its own transaction and returns the new count.
 *
 * It must be separate from the claim: the processor's writes are rolled back with the
 * claim transaction, so an increment made inside it would disappear too. Nothing else is
 * written here, and `processed_at` stays null, which is what makes the event claimable
 * again on the next poll.
 *
 * `and processed_at is null` guards the gap between the rollback and this transaction:
 * another worker can claim and finish the row in that window, and without the guard this
 * counter would rise on an event that is already done. `undefined` therefore means the
 * increment matched no row — another worker processed it, or (nothing in this codebase
 * deletes an inbound event) it vanished — and the caller does not invent an attempt.
 */
async function recordFailedAttempt(pool: Pool, id: string): Promise<number | undefined> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ attempts: number }>(
      'update inbound_events set attempts = attempts + 1 where id = $1 and processed_at is null returning attempts',
      [id],
    )
    return rows[0]?.attempts
  })
}

/**
 * Claims the oldest queued event, runs its processor and marks it processed, in one
 * transaction.
 *
 * The claim is the concurrency control: `for update skip locked` takes the row lock and
 * makes a second worker skip the row instead of waiting for it, and the
 * `processed_at is null` filter is what makes a claim mean "not yet paid". `attempts <
 * MAX_EVENT_ATTEMPTS` is the retry bound: a poison event that fails that many times drops
 * out of the claim instead of staying the oldest row forever, so the rest of its provider's
 * queue drains. It stays in the table at the bound, for the operator to find. The processor
 * runs inside the same transaction, so its awards and the processed mark commit together:
 * a crash between them cannot pay the event twice, and a throw cannot leave half the work
 * behind.
 *
 * This deliberately does not call `ingestEvent`. That function exists for first arrival;
 * it treats an existing `(provider, event_id)` as a duplicate and skips the handler,
 * which is exactly the retry a failed event needs here.
 *
 * On a throw the transaction rolls back, a second small transaction increments `attempts`,
 * the failure is logged with the event id and the attempt number, and the poll reports
 * `'empty'` so the loop waits and then takes the next row. There is no dead-letter table
 * at alpha: a row that reaches `MAX_EVENT_ATTEMPTS` stays unprocessed, is no longer
 * claimed, and the operator finds it by its `attempts` count.
 *
 * Only providers with a registered processor are claimed. An event from any other provider
 * stays in the table untouched — it is not marked processed, so it is not lost, and its
 * `attempts` does not climb for a handler that does not exist. `runLoop` reports those
 * providers once each.
 */
export async function processOne(pool: Pool, processors: ProcessorMap): Promise<ProcessOutcome> {
  let claimed: ClaimedEvent | undefined

  try {
    return await withTransaction(pool, async (tx) => {
      const { rows } = await tx.query<ClaimedEvent>(
        `select id, provider, event_id, payload
           from inbound_events
          where processed_at is null
            and attempts < ${MAX_EVENT_ATTEMPTS}
            and provider = any($1::text[])
          order by id
          for update skip locked
          limit 1`,
        [[...processors.keys()]],
      )
      const event = rows[0]
      if (event === undefined) return 'empty' as const

      // Recorded before the processor runs, so the failure path knows which row it is
      // counting even though the transaction above is about to disappear.
      claimed = event

      const processor = requireProcessor(processors, event.provider)
      await processor(tx, event.payload)

      await tx.query('update inbound_events set processed_at = now() where id = $1', [event.id])
      return 'processed' as const
    })
  } catch (error) {
    // No claim was made: the database refused the claim itself (a lost connection, a
    // broken query). The loop logs that and retries; it is not an event's failure.
    if (claimed === undefined) throw error

    const attempt = await recordFailedAttempt(pool, claimed.id)
    if (attempt === undefined) {
      console.error(
        `[worker] inbound event #${claimed.id} (${claimed.provider} "${claimed.event_id}") failed, ` +
          'but another worker processed it before the attempt could be counted; there is nothing to retry',
        error,
      )
      return 'empty'
    }
    console.error(
      `[worker] inbound event #${claimed.id} (${claimed.provider} "${claimed.event_id}") failed on ` +
        `attempt ${attempt}; it stays unprocessed and the claim retries it while ` +
        `attempts < ${MAX_EVENT_ATTEMPTS}`,
      error,
    )
    return 'empty'
  }
}

export interface RunLoopOptions {
  /** How long to wait after a poll that found nothing. Defaults to one second. */
  intervalMs?: number
  /** Stops the loop when it fires; the poll in flight runs to completion first. */
  signal?: AbortSignal
  /**
   * Replaces the timer between polls. A test seam: the loop's real behavior is a plain
   * timer, and a test can decide when a tick ends and when the signal fires without
   * sleeping.
   */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Resolves after `ms`, or as soon as `signal` fires.
 *
 * The `aborted` check before the timer matters for shutdown: a signal that arrived while
 * a poll was failing must end the loop immediately, not after one more full interval.
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
 * Polls for queued events until `signal` fires.
 *
 * A poll that claimed and processed a row immediately tries the next one, so a backlog
 * drains at the database's pace. A poll that found nothing waits `intervalMs` first: that
 * pause is what keeps an idle worker from hammering the database in a tight loop. A poll
 * that failed logs the reason and waits the same way, so an outage produces one line per
 * interval rather than a spinning process.
 *
 * A processor's own failure never reaches this function: `processOne` logs it, counts the
 * attempt and reports `'empty'`.
 */
export async function runLoop(
  pool: Pool,
  processors: ProcessorMap,
  options: RunLoopOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const signal = options.signal
  const wait = options.wait ?? waitForSignal
  const reported = new Set<string>()

  while (signal?.aborted !== true) {
    try {
      const outcome = await processOne(pool, processors)
      if (outcome === 'empty') {
        await reportUnroutedProviders(pool, processors, reported)
        await wait(intervalMs, signal)
      }
    } catch (error) {
      console.error('[worker] the poll failed; the loop will try again after the interval', error)
      await wait(intervalMs, signal)
    }
  }
}
