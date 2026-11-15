import type { Pool } from 'pg'
import {
  ALPHA_RESET_CONFIRM_ENV,
  ERASURE_PEPPER_ENV,
  PURGE_CONFIRM_ENV,
  PURGE_CONFIRM_VALUE,
  eraseFan,
  eraseIdentity,
  exportFan,
  findActiveFanId,
  findIdentityIdsByHandle,
  purgeBatch,
  recomputeLevels,
  resetAlpha,
  withTransaction,
} from '@ashuworld/ledger'
import { PROVIDER_NAMES, isProviderName } from '@ashuworld/providers'
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
 * The shape of a `provider_identities.id`: a canonical UUID.
 *
 * The same check the api makes before a lookup, repeated here because the worker does not
 * depend on the api. The column is a uuid, so handing Postgres `not-a-uuid` raises a syntax
 * error in a transaction that has already been opened; a caller-chosen string that cannot
 * name a row is refused before anything connects, which is why a malformed id touches
 * nothing.
 */
const IDENTITY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isIdentityId(value: string): boolean {
  return IDENTITY_ID_PATTERN.test(value)
}

/**
 * `PURGE_CONFIRM` or a refusal, in the alpha reset's three sentences.
 *
 * Absent, blank and wrong each get their own line for the same reason the reset does: an
 * operator reading a failed job needs to know which of the three happened, and "nothing
 * was deleted" has to be true of every refusal. The check runs before the pepper and
 * before any connection is taken, so a refused purge has touched nothing.
 */
function requirePurgeConfirmation(): void {
  const raw = process.env[PURGE_CONFIRM_ENV]

  if (raw === undefined) {
    throw new Error(
      `refusing the purge: ${PURGE_CONFIRM_ENV} is not set. ` +
        `Set it to "${PURGE_CONFIRM_VALUE}" to arm the retention pass. Nothing was deleted.`,
    )
  }
  if (raw.trim() === '') {
    throw new Error(
      `refusing the purge: ${PURGE_CONFIRM_ENV} is blank. ` +
        `Set it to "${PURGE_CONFIRM_VALUE}" to arm the retention pass. Nothing was deleted.`,
    )
  }
  if (raw !== PURGE_CONFIRM_VALUE) {
    throw new Error(
      `refusing the purge: ${PURGE_CONFIRM_ENV} does not match ` +
        `"${PURGE_CONFIRM_VALUE}", so this looks like a typo rather than an operator ` +
        'arming the retention pass. Nothing was deleted.',
    )
  }
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
 * - `erase-identity <provider> <displayHandle>`: anonymise one provider account that never
 *   joined a fan account, guarded by `ERASURE_PEPPER`, and only when the handle names
 *   exactly one identity;
 * - `erase-identity-id <uuid>`: the same erasure for the operator whose handle named
 *   several identities, addressed by the id the ambiguous refusal printed;
 * - `purge [--dry-run]`: apply the retention windows, guarded by `PURGE_CONFIRM`. The dry
 *   run selects and counts but writes nothing; the real run repeats the batch until a pass
 *   has no fan or identity left to erase, because each batch is capped;
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
        err(
          `[worker] no active account has that handle: ${handle}; a re-run of an erasure ends ` +
            'here, and a handle that never existed looks the same, so check the spelling ' +
            'before assuming the account is gone',
        )
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

  if (argv[0] === 'erase-identity') {
    if (argv.length !== 3) {
      err(
        `[worker] "erase-identity" takes exactly a provider and a display handle, but got ` +
          `${JSON.stringify(argv.slice(1))}; it erases one provider account that never ` +
          'joined a fan account and nothing else',
      )
      return 1
    }

    const provider = argv[1] as string
    const displayHandle = argv[2] as string
    if (!isProviderName(provider)) {
      err(
        `[worker] unknown provider "${provider}"; "erase-identity" accepts ` +
          PROVIDER_NAMES.join(', '),
      )
      return 1
    }

    try {
      const pepper = loadPepper()
      // A display handle is not unique on the platform side, so the lookup may answer with
      // several ids. Reading them first lets this command refuse an ambiguous request
      // instead of erasing whichever row happened to come back first.
      const identityIds = await withTransaction(deps.pool, (tx) =>
        findIdentityIdsByHandle(tx, { provider, displayHandle }),
      )
      if (identityIds.length === 0) {
        err(`[worker] no identity matches that provider and handle: ${provider} ${displayHandle}`)
        return 1
      }
      if (identityIds.length > 1) {
        err(
          `[worker] ${identityIds.length} identities share that provider and handle, so the ` +
            'request is ambiguous; run "erase-identity-id" with the id of the one meant: ' +
            identityIds.join(', '),
        )
        return 1
      }

      const identityId = identityIds[0] as string
      const result = await withTransaction(deps.pool, (tx) =>
        eraseIdentity(tx, { identityId, pepper }),
      )
      out(
        `[worker] identity erasure complete: erased ${result.erased}, ` +
          `forfeitedEntries ${result.forfeitedEntries}; ` +
          (result.erased
            ? 'the identity is erased'
            : 'it was already erased, so nothing changed'),
      )
      return 0
    } catch (error) {
      err(`[worker] the erasure did not run: ${messageOf(error)}`)
      return 1
    }
  }

  if (argv[0] === 'erase-identity-id') {
    if (argv.length !== 2) {
      err(
        `[worker] "erase-identity-id" takes exactly one identity id, but got ` +
          `${JSON.stringify(argv.slice(1))}; it erases the row that id names and nothing else`,
      )
      return 1
    }

    const identityId = argv[1] as string
    // Checked before the pepper and before any connection: a string that cannot be a uuid
    // would make Postgres raise a syntax error inside an open transaction, and the refusal
    // has to leave the database untouched.
    if (!isIdentityId(identityId)) {
      err(
        `[worker] "${identityId}" is not an identity id; "erase-identity-id" takes the ` +
          'canonical uuid the ambiguous "erase-identity" refusal prints',
      )
      return 1
    }

    try {
      const pepper = loadPepper()
      // The ledger owns the refusals that need the row: a missing id and an identity that
      // is still attached to a fan account both come back from here as errors, so this
      // branch never has to guess whether the row exists.
      const result = await withTransaction(deps.pool, (tx) =>
        eraseIdentity(tx, { identityId, pepper }),
      )
      // Three outcomes, not two. `erased` false with a forfeit is a retry that met an earn
      // recorded after the first erasure: the row was already anonymised, but that earn is
      // gone now, so "nothing changed" would be a lie.
      const outcome = result.erased
        ? 'the identity is erased'
        : result.forfeitedEntries > 0
          ? 'the row was already anonymised, and its live earns were forfeited this time'
          : 'it was already erased, so nothing changed'
      out(
        `[worker] identity erasure complete: erased ${result.erased}, ` +
          `forfeitedEntries ${result.forfeitedEntries}; ${outcome}`,
      )
      return 0
    } catch (error) {
      err(`[worker] the erasure did not run: ${messageOf(error)}`)
      return 1
    }
  }

  if (argv[0] === 'purge') {
    const extra = argv.slice(1)
    if (extra.length > 1 || (extra.length === 1 && extra[0] !== '--dry-run')) {
      err(
        `[worker] "purge" takes no argument or "--dry-run", but got ` +
          `${JSON.stringify(extra)}; it is armed by ${PURGE_CONFIRM_ENV} alone, and there is ` +
          'deliberately no --force',
      )
      return 1
    }
    const dryRun = extra.length === 1

    try {
      requirePurgeConfirmation()
      const pepper = loadPepper()

      if (dryRun) {
        const counts = await purgeBatch(deps.pool, { pepper, dryRun: true })
        out(
          `[worker] purge dry run: fans ${counts.fans}, identities ${counts.identities}, ` +
            `events ${counts.events}, audit ${counts.audit}; nothing was written`,
        )
        return 0
      }

      // Each batch is capped per erasure pass, so a backlog takes several. The loop ends on
      // the first pass that erased no fan and no identity: every candidate is now handled,
      // and another pass would only re-delete what the window holds.
      let fans = 0
      let identities = 0
      let events = 0
      let audit = 0
      for (;;) {
        const counts = await purgeBatch(deps.pool, { pepper, dryRun: false })
        fans += counts.fans
        identities += counts.identities
        events += counts.events
        audit += counts.audit
        out(
          `[worker] purge batch: fans ${counts.fans}, identities ${counts.identities}, ` +
            `events ${counts.events}, audit ${counts.audit}`,
        )
        if (counts.fans + counts.identities === 0) break
      }

      out(
        `[worker] purge complete: fans ${fans}, identities ${identities}, ` +
          `events ${events}, audit ${audit}`,
      )
      return 0
    } catch (error) {
      err(`[worker] the purge did not run: ${messageOf(error)}`)
      return 1
    }
  }

  if (argv[0] !== 'reset') {
    err(
      `[worker] unknown argument "${argv[0]}"; run the worker with no argument to drain ` +
        'the queue, with "reset" to wipe all xp for alpha, with "recompute-levels" ' +
        'to apply the current level table, with "export-fan <handle>" to print one ' +
        'account, with "erase-fan <handle>" to erase one account, with ' +
        '"erase-identity <provider> <handle>" to erase one never-linked identity, with ' +
        '"erase-identity-id <uuid>" to erase a specific never-linked identity, or ' +
        'with "purge [--dry-run]" to apply the retention windows',
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
