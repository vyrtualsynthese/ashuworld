import type { Pool } from 'pg'
import {
  ALPHA_RESET_CONFIRM_ENV,
  enqueueEvent,
  monthKey,
  recomputeLevels,
  resetAlpha,
} from '@ashuworld/ledger'
import { discoveryEventId, type DiscoveredPerson } from '@ashuworld/providers'
import type { Connector } from './connectors/types.js'
import { runDiscovery } from './discovery.js'
import { loadWorkerGameConfig } from './gameConfig.js'
import { runLoop } from './loop.js'
import type { ProcessorMap } from './processors.js'

/** The game config version the reset records, and every other process in the chart reads. */
export const CONFIG_VERSION_ENV = 'GAME_CONFIG_VERSION'

/** How long the worker waits between discovery rounds: fifteen minutes, the sync cadence. */
export const DEFAULT_SYNC_INTERVAL_MS = 900_000

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
      const enqueue = async (person: DiscoveredPerson): Promise<void> => {
        const month = monthKey(new Date())
        await enqueueEvent(deps.pool, {
          provider: person.provider,
          eventId: discoveryEventId('sync', person, month),
          payload: { kind: 'discovery', ...person },
        })
      }

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

  if (argv[0] !== 'reset') {
    err(
      `[worker] unknown argument "${argv[0]}"; run the worker with no argument to drain ` +
        'the queue, with "reset" to wipe all xp for alpha, or with "recompute-levels" ' +
        'to apply the current level table',
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
