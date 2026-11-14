/**
 * The process configuration the worker reads at startup.
 *
 * `DATABASE_URL` has no default: the worker is a consumer of the same schema the api
 * writes, and a guessed connection would either fail on the first poll with a driver
 * error or, worse, point at a database nobody intended.
 *
 * The discovery switches are off by default. The stub connector writes fans and XP into
 * the real ledger, so it needs two independent keys to run: naming it in
 * `PLATFORM_CONNECTORS` says what to do, and `ALLOW_STUB_CONNECTORS=true` says this
 * deployment means it. One without the other is a mistake at startup, not a silent
 * no-op, because the failure mode of a live stub is fabricated data that looks real.
 */
export interface WorkerEnv {
  DATABASE_URL: string
  /**
   * The connectors to run discovery for. Empty means the worker only drains what other
   * processes already queued.
   */
  PLATFORM_CONNECTORS: ConnectorName[]
  /** The second key the stub needs; see `loadWorkerEnv` for the pairing rule. */
  ALLOW_STUB_CONNECTORS: boolean
  /** How many people the stub invents per run. Only read when the stub is enabled. */
  STUB_PEOPLE: number
  /** How long the worker waits between discovery runs, in seconds. */
  SYNC_INTERVAL_SECONDS: number
}

/** The connectors that exist. Kept explicit so a typo fails at startup, not mid-sync. */
export type ConnectorName = 'stub'

const CONNECTOR_NAMES: readonly ConnectorName[] = ['stub']

const DEFAULT_STUB_PEOPLE = 250
const MAX_STUB_PEOPLE = 5_000
/** Fifteen minutes: the sync cadence, also the fallback when the variable is absent. */
export const DEFAULT_SYNC_INTERVAL_SECONDS = 900
const MAX_SYNC_INTERVAL_SECONDS = 31_536_000

/** The only shape a count or interval may take: plain decimal digits, nothing else. */
const PLAIN_INTEGER = /^\d+$/

/** A required variable, or a plain error that names it. Empty is missing, and the value is trimmed. */
function required(raw: NodeJS.ProcessEnv, name: string): string {
  const value = raw[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required but was not set; export it before starting the worker`)
  }
  return value.trim()
}

/**
 * A boolean variable, absent meaning `false`.
 *
 * Only `true`/`false` (any case) are accepted: a typo such as `yes` would otherwise
 * silently mean `false`, and `ALLOW_STUB_CONNECTORS` turning itself off is exactly the
 * mistake that should stop the worker.
 */
function flag(raw: NodeJS.ProcessEnv, name: string): boolean {
  const value = raw[name]
  if (value === undefined || value.trim() === '') return false
  const normalised = value.trim().toLowerCase()
  if (normalised === 'true') return true
  if (normalised === 'false') return false
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(value)}`)
}

/**
 * An integer in range, or `fallback` when absent.
 *
 * `Number` alone is too generous: `2.5` and `-1` parse, `1e3` and `0x10` parse as other
 * numbers than they look, and an empty string is `0`. So the text must be plain decimal
 * digits before it is converted. Every value that is not a whole number inside the range
 * is a startup error naming the variable, because a bad count or interval only surfaces
 * later as odd data.
 */
function integer(
  raw: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw[name]
  if (value === undefined || value.trim() === '') return fallback
  const text = value.trim()
  if (!PLAIN_INTEGER.test(text)) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(value)}`,
    )
  }
  const parsed = Number(text)
  if (parsed < min || parsed > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}, got ${JSON.stringify(value)}`,
    )
  }
  return parsed
}

/**
 * The connector list: comma-separated, trimmed, empty entries dropped, duplicates kept
 * once. An unknown name fails here, so no later code has to fall back to "ignore it".
 */
function connectors(raw: NodeJS.ProcessEnv): ConnectorName[] {
  const value = raw['PLATFORM_CONNECTORS']
  if (value === undefined || value.trim() === '') return []
  const names: ConnectorName[] = []
  for (const entry of value.split(',')) {
    const name = entry.trim()
    if (name === '') continue
    if (!(CONNECTOR_NAMES as readonly string[]).includes(name)) {
      throw new Error(
        `PLATFORM_CONNECTORS must name only ${CONNECTOR_NAMES.join(', ')}, ` +
          `got ${JSON.stringify(name)} in ${JSON.stringify(value)}`,
      )
    }
    if (!(names as readonly string[]).includes(name)) names.push(name as ConnectorName)
  }
  return names
}

/**
 * Reads the environment. Takes `raw` so a test can prove every branch without mutating
 * the process it runs in; the default argument is what the process entry point uses.
 */
export function loadWorkerEnv(raw: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const connectorNames = connectors(raw)
  const allowStub = flag(raw, 'ALLOW_STUB_CONNECTORS')
  const hasStub = connectorNames.includes('stub')
  if (hasStub && !allowStub) {
    throw new Error(
      'PLATFORM_CONNECTORS names "stub" but ALLOW_STUB_CONNECTORS is not "true"; ' +
        'the stub writes fabricated fans and XP, so it needs both switches',
    )
  }
  if (allowStub && !hasStub) {
    throw new Error(
      'ALLOW_STUB_CONNECTORS is "true" but PLATFORM_CONNECTORS does not name "stub"; ' +
        'the allow switch alone enables nothing',
    )
  }
  return {
    DATABASE_URL: required(raw, 'DATABASE_URL'),
    PLATFORM_CONNECTORS: connectorNames,
    ALLOW_STUB_CONNECTORS: allowStub,
    STUB_PEOPLE: integer(raw, 'STUB_PEOPLE', DEFAULT_STUB_PEOPLE, 1, MAX_STUB_PEOPLE),
    SYNC_INTERVAL_SECONDS: integer(
      raw,
      'SYNC_INTERVAL_SECONDS',
      DEFAULT_SYNC_INTERVAL_SECONDS,
      1,
      MAX_SYNC_INTERVAL_SECONDS,
    ),
  }
}
