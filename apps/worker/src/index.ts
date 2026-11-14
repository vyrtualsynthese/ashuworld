import { createPool } from '@ashuworld/ledger'
import { runCli } from './cli.js'
import type { ProcessorMap } from './processors.js'

/**
 * The processors this process runs.
 *
 * Empty for now: the platform connectors and their processors arrive in later plans. The
 * loop is still worth running — it is what drains whatever is already queued once a
 * processor is registered, and an empty map is the honest state of a worker that has
 * nowhere to send an event yet rather than a reason not to start.
 */
const PROCESSORS: ProcessorMap = new Map()

/**
 * `DATABASE_URL` or a message that names it. Empty is missing.
 *
 * The worker has no useful default: it is a consumer of the same schema the api writes,
 * and a guessed connection would either fail on the first poll with a driver error or,
 * worse, point at a database nobody intended.
 */
function loadDatabaseUrl(raw: NodeJS.ProcessEnv = process.env): string {
  const url = raw['DATABASE_URL']
  if (url === undefined || url.trim() === '') {
    throw new Error('DATABASE_URL is required but was not set; export it before starting the worker')
  }
  return url.trim()
}

/**
 * The process shell: real environment, real pool, real signals.
 *
 * The command dispatch lives in `runCli` and returns an exit code; this function only
 * wires the environment, signals and the pool. SIGTERM (and SIGINT for a terminal) aborts
 * the loop. A poll already in flight finishes and commits — the abort is checked between
 * polls — so shutdown cannot interrupt a processor halfway through its transaction. Then
 * the pool closes. A second signal reaches the same idempotent `stop`.
 *
 * The reset subcommand is not interruptible by the signal: it is one transaction, and
 * Postgres rolls it back if the process dies, so there is no half-wiped state to finish.
 */
async function main(argv: readonly string[]): Promise<number> {
  const pool = createPool(loadDatabaseUrl())
  const controller = new AbortController()

  const stop = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) return
    console.error(`[worker] ${signal} received; finishing the event in flight and stopping`)
    controller.abort()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  let code = 1
  try {
    code = await runCli(argv, { pool, processors: PROCESSORS, signal: controller.signal })
  } finally {
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
    try {
      await pool.end()
    } catch (error) {
      console.error('[worker] the pool did not close cleanly', error)
      code = 1
    }
  }
  return code
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
