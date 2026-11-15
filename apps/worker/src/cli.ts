import type { Pool } from 'pg'
import {
  ALPHA_RESET_CONFIRM_ENV,
  ERASURE_PEPPER_ENV,
  eraseFan,
  exportFan,
  findActiveFanId,
  recomputeLevels,
  resetAlpha,
  withTransaction,
} from '@ashuworld/ledger'
import type { Connector } from './connectors/types.js'
import { DEFAULT_SYNC_INTERVAL_SECONDS } from './config.js'
import { createDiscoveryEnqueue, runDiscovery } from './discovery.js'
import { loadWorkerGameConfig } from './gameConfig.js'
import { runLoop } from './loop.js'
import type { ProcessorMap } from './processors.js'

/** The game config version the reset records, and every other process in the chart reads. */
export const CONFIG_VERSION_ENV = 'GAME_CONFIG_VERSION'

/**
 * How long the worker waits between discovery rounds: fifteen minutes, the sync cadence.
 * Derived from the config default so the two cannot drift apart.
 */
export const DEFAULT_SYNC_INTERVAL_MS = DEFAULT_SYNC_INTERVAL_SECONDS * 1000

export interface CliDeps {
  /** The database the command talks to. The shell owns creating and closing it. */
  pool: Pool
  /** The processors the queue loop runs. */
  processors: ProcessorMap
  /**
   * The discovery sources to run alongside the queue. Empty, the default, means the
   * worker only drains what other processes already queued.
   */
  connectors?: Connector[]
  /** How long to wait between discovery rounds, in milliseconds. Defaults to fifteen minutes. */
  syncIntervalMs?: number
  /** Where progress goes. Defaults to `console.log`. */
  out?: (line: string) => void
  /** Where failures go. Defaults to `console.error`. */
  err?: (line: string) => void
  /** Stops the queue loop when it fires. The reset runs to completion regardless. */
  signal?: AbortSignal
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/**
 * `GAME_CONFIG_VERSION` or a refusal.
 *
 * A wipe without a version cannot be attributed to a set of numbers, and the log line is
 * the only record it leaves (the transaction empties `audit_log`). Empty is missing, the
 * same rule `DATABASE_URL` follows in the process shell.
 */
function loadConfigVersion(): string {
  const version = process.env[CONFIG_VERSION_ENV]
  if (version === undefined || version.trim() === '') {
    throw new Error(
      `${CONFIG_VERSION_ENV} is required for the alpha reset but was not set; ` +
        'the wipe is refused so it cannot run without a version to record',
    )
  }
  return version.trim()
}

/**
 * `ERASURE_PEPPER` or a refusal.
 *
 * Read by the erasure commands only, never at startup: a worker that merely drains the
 * queue has no business holding the secret that anonymises provider ids, and a deployment
 * without it must still start.
 *
 * Empty is missing for the same reason as everywhere else in this process, and the
 * message names the variable so an operator reading a failed job knows what to set.
 */
function loadPepper(): string {
  const pepper = process.env[ERASURE_PEPPER_ENV]
  if (pepper === undefined || pepper.trim() === '') {
    throw new Error(
      `${ERASURE_PEPPER_ENV} is required to erase an account but was not set; ` +
        'the erasure is refused so it cannot run without the secret that anonymises the ' +
        'provider ids',
    )
  }
  return pepper.trim()
}

/**
 * The command line, as `process.argv.slice(2)`.
 *
 * `argv` is passed in rather than read here so the dispatch is testable: the tests call
 * this directly, and the process shell only wires the real pool and signals.
 *
 * - no argument: drain the queue, i.e. normal worker duty, and when `deps.connectors` is
 *   non-empty also run discovery beside it so the queue has something to drain;
 * - `reset`: the one deliberate alpha wipe, guarded by `ALPHA_RESET_CONFIRM`;
 * - `recompute-levels`: re-read every fan's peak through the current level table and
 *   raise whatever the table now puts higher. It reads `GAME_CONFIG_VERSION` from the
 *   file it loads (the api's file), not from the environment, because the pass needs the
 *   thresholds themselves and the version is only what it reports;
 * - `export-fan <handle>`: print one account's ledger history as JSON, for the person who
 *   asked to receive it;
 * - `erase-fan <handle>`: anonymise one account in place, guarded by `ERASURE_PEPPER`;
 * - anything else, including extra arguments after a command: a refusal with a non-zero
 *   exit code. There is deliberately no `--force`: a destructive command should not have
 *   a flag that removes its own guard.
 *
 * Returns the exit code instead of calling `process.exit`, so the shell keeps ownership of
 * the process and a test can assert the result.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const out = deps.out ?? ((line: string): void => console.log(line))
  const err = deps.err ?? ((line: string): void => console.error(line))

  if (argv.length === 0) {
    const connectors = deps.connectors ?? []
    const signalOptions = deps.signal === undefined ? {} : { signal: deps.signal }
    try {
      // No connector: today's worker exactly, one loop and nothing else competing for the
      // signal. This branch stays first so a deployment without platform keys cannot gain
      // a timer it never needed.
      if (connectors.length === 0) {
        await runLoop(deps.pool, deps.processors, signalOptions)
        return 0
      }

      // Discovery only writes queue rows; the drain loop stays the only thing that pays
      // them. Both loops share one signal, so shutdown stops finding people and stops
      // paying them at the same moment.
      const enqueue = createDiscoveryEnqueue(deps.pool)

      await Promise.all([
        runLoop(deps.pool, deps.processors, signalOptions),
        runDiscovery({
          connectors,
          enqueue,
          intervalMs: deps.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        }),
      ])
      return 0
    } catch (error) {
      err(`[worker] the loop stopped with an error: ${messageOf(error)}`)
      return 1
    }
  }

  if (argv[0] === 'recompute-levels') {
    if (argv.length > 1) {
      err(
        `[worker] "recompute-levels" takes no arguments, but got ` +
          `${JSON.stringify(argv.slice(1))}; it reads the level table from the game config alone`,
      )
      return 1
    }

    try {
      const cfg = loadWorkerGameConfig()
      const counts = await recomputeLevels(deps.pool, cfg)
      out(
        `[worker] level recompute complete: scanned ${counts.scanned} fans, ` +
          `raised ${counts.raised} levels; game config ${cfg.version}`,
      )
      return 0
    } catch (error) {
      err(`[worker] the level recompute did not run: ${messageOf(error)}`)
      return 1
    }
  }

  if (argv[0] === 'export-fan') {
    if (argv.length !== 2) {
      err(
        `[worker] "export-fan" takes exactly one handle, but got ` +
          `${JSON.stringify(argv.slice(1))}; it exports the account that handle names and ` +
          'nothing else',
      )
      return 1
    }

    // `argv[1]` is the handle; the length check above is what makes it present.
    const handle = argv[1] as string
    try {
      const document = await withTransaction(deps.pool, (tx) => exportFan(tx, handle))
      if (document === null) {
        err(`[worker] no active account has that handle: ${handle}`)
        return 1
      }
      out(JSON.stringify(document, null, 2))
      return 0
    } catch (error) {
      err(`[worker] the export did not run: ${messageOf(error)}`)
      return 1
    }
  }

  if (argv[0] === 'erase-fan') {
    if (argv.length !== 2) {
      err(
        `[worker] "erase-fan" takes exactly one handle, but got ` +
          `${JSON.stringify(argv.slice(1))}; it erases the account that handle names and ` +
          'nothing else',
      )
      return 1
    }

    const handle = argv[1] as string
    try {
      const pepper = loadPepper()
      // The id is read first because `eraseFan` refuses to run outside a transaction, and
      // the account may be gone by the time the erase opens one: the helper it calls
      // re-checks `erased_at`, so a concurrent erasure is answered as a no-op rather
      // than resurrected.
      const fanId = await withTransaction(deps.pool, (tx) => findActiveFanId(tx, handle))
      if (fanId === null) {
        err(`[worker] no active account has that handle: ${handle}`)
        return 1
      }
      const result = await withTransaction(deps.pool, (tx) => eraseFan(tx, { fanId, pepper }))
      out(
        `[worker] account erasure complete: identities ${result.identities}, ` +
          `forfeitedEntries ${result.forfeitedEntries}; ` +
          (result.erased ? 'the account is erased' : 'it was already erased, so nothing changed'),
      )
      return 0
    } catch (error) {
      err(`[worker] the erasure did not run: ${messageOf(error)}`)
      return 1
    }
  }

  if (argv[0] !== 'reset') {
    err(
      `[worker] unknown argument "${argv[0]}"; run the worker with no argument to drain ` +
        'the queue, with "reset" to wipe all xp for alpha, with "recompute-levels" ' +
        'to apply the current level table, with "export-fan <handle>" to print one ' +
        'account, or with "erase-fan <handle>" to erase one account',
    )
    return 1
  }

  if (argv.length > 1) {
    err(
      `[worker] the reset takes no arguments, but got ${JSON.stringify(argv.slice(1))}; ` +
        `it is armed by ${ALPHA_RESET_CONFIRM_ENV} alone`,
    )
    return 1
  }

  try {
    const configVersion = loadConfigVersion()
    const counts = await resetAlpha(deps.pool, { configVersion })
    out(
      `[worker] alpha reset complete: xp_entries ${counts.deletedEntries}, ` +
        `provider_identities ${counts.deletedIdentities}, sessions ${counts.deletedSessions}; ` +
        `game config ${configVersion}`,
    )
    return 0
  } catch (error) {
    err(`[worker] the alpha reset did not run: ${messageOf(error)}`)
    return 1
  }
}
