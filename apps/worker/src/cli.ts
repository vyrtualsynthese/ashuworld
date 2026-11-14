import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { loadGameConfigFile } from '@ashuworld/gameconfig'
import { ALPHA_RESET_CONFIRM_ENV, recomputeLevels, resetAlpha } from '@ashuworld/ledger'
import { runLoop } from './loop.js'
import type { ProcessorMap } from './processors.js'

/** The game config version the reset records, and every other process in the chart reads. */
export const CONFIG_VERSION_ENV = 'GAME_CONFIG_VERSION'

/**
 * The same file the api reads, resolved from this module rather than from an environment
 * variable, so both bundles find `/packages/gameconfig/config/game.json` in the image.
 * From `apps/worker/src/cli.ts` the three levels climb to the repository root; from the
 * bundled `/app/dist/worker.js` they reach `/`, which is where both Dockerfiles place it.
 */
const GAME_CONFIG_PATH = fileURLToPath(
  new URL('../../../packages/gameconfig/config/game.json', import.meta.url),
)

export interface CliDeps {
  /** The database the command talks to. The shell owns creating and closing it. */
  pool: Pool
  /** The processors the queue loop runs. */
  processors: ProcessorMap
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
 * - no argument: drain the queue, i.e. normal worker duty;
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
    try {
      await runLoop(
        deps.pool,
        deps.processors,
        deps.signal === undefined ? {} : { signal: deps.signal },
      )
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
      const cfg = loadGameConfigFile(GAME_CONFIG_PATH)
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
