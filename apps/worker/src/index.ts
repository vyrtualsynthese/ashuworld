import { createPool } from '@ashuworld/ledger'
import { runCli } from './cli.js'
import { loadWorkerEnv } from './config.js'
import { createConnectors } from './connectors/index.js'
import { loadWorkerGameConfig } from './gameConfig.js'
import { createProcessors } from './processors.js'

/** The startup line that says what discovery this process runs, without naming any credential. */
function logConnectors(names: readonly string[]): void {
  if (names.length === 0) {
    console.log(
      '[worker] no discovery connector is on; the worker only drains what other processes queued',
    )
    return
  }
  console.log(`[worker] discovery connectors on: ${names.join(', ')}`)
}

/**
 * The stub warning: loud, at startup, and impossible to mistake for real data.
 *
 * The stub writes invented fans and XP into the same tables a real connector would, so
 * forgetting to turn it off leaves fabricated balances that look exactly like earned ones.
 */
function warnStub(people: number): void {
  console.warn(
    `[worker] the stub connector is ACTIVE: it invents ${people} people per run and ` +
      'writes them to the real ledger. This is demo data, not real followers; ' +
      'unset PLATFORM_CONNECTORS and ALLOW_STUB_CONNECTORS to stop it.',
  )
}

/**
 * The process shell: real environment, real pool, real signals.
 *
 * The environment is read and validated first, so a typo in a switch stops the process
 * before it opens a connection. Then the game config, the pool, the processors and the
 * connectors are built once, at startup, and handed to the command dispatch.
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
  const env = loadWorkerEnv()
  const cfg = loadWorkerGameConfig()
  const pool = createPool(env.DATABASE_URL)
  const processors = createProcessors(cfg)
  const connectors = createConnectors(env)

  logConnectors(connectors.map((connector) => connector.name))
  if (env.PLATFORM_CONNECTORS.includes('stub')) warnStub(env.STUB_PEOPLE)

  const controller = new AbortController()

  const stop = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) return
    console.error(`[worker] ${signal} received; finishing the event in flight and stopping`)
    controller.abort()
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  let code: number | undefined
  try {
    code = await runCli(argv, {
      pool,
      processors,
      connectors,
      syncIntervalMs: env.SYNC_INTERVAL_SECONDS * 1000,
      signal: controller.signal,
    })
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
  return code ?? 1
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
