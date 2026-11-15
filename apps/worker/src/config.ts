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
 *
 * Twitch is the opposite shape: it needs five values at once (a client pair, the channel
 * login, that channel's refresh token and the key that seals grants), so a partial set is
 * a startup error even when discovery is off. A complete set without `'twitch'` in
 * `PLATFORM_CONNECTORS` is allowed and unused: an operator may stage the credentials for a
 * later rollout. Every message names the variable and never echoes the value, because
 * these values are credentials and a startup error is the easiest way into a log store.
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
  /** The Twitch application's client id. Set with its secret or not at all. */
  TWITCH_CLIENT_ID?: string
  /** The Twitch application's client secret. Set with the client id or not at all. */
  TWITCH_CLIENT_SECRET?: string
  /** The channel whose followers are discovered. Required when `'twitch'` is listed. */
  TWITCH_CHANNEL_LOGIN?: string
  /** The channel owner's refresh token, which seeds the grant the worker rotates. */
  TWITCH_CHANNEL_REFRESH_TOKEN?: string
  /** 32 random bytes, base64: the key the channel owner's staged grant is sealed with. */
  PLATFORM_TOKEN_KEY?: string
}

/** The connectors that exist. Kept explicit so a typo fails at startup, not mid-sync. */
export type ConnectorName = 'stub' | 'twitch'

const CONNECTOR_NAMES: readonly ConnectorName[] = ['stub', 'twitch']

const DEFAULT_STUB_PEOPLE = 250
const MAX_STUB_PEOPLE = 5_000
/** Fifteen minutes: the sync cadence, also the fallback when the variable is absent. */
export const DEFAULT_SYNC_INTERVAL_SECONDS = 900
const MAX_SYNC_INTERVAL_SECONDS = 31_536_000
/** AES-256 takes exactly this many key bytes, so any other length is a mistyped key. */
const TOKEN_KEY_BYTES = 32

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
 * An optional variable: absent or blank is `undefined`, otherwise the trimmed value.
 *
 * Blank counts as absent so an empty line in an `.env` file cannot turn into `''` and
 * then pass a presence check that only looks for `undefined`.
 */
function optional(raw: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = raw[name]
  if (value === undefined || value.trim() === '') return undefined
  return value.trim()
}

/**
 * A credential pair read together: the Twitch client id and its secret.
 *
 * Neither set means Twitch is off, and both are `undefined`. One set is a startup error
 * naming the missing half, even when `'twitch'` is not in `PLATFORM_CONNECTORS`: half a
 * pair is a mistake an operator will otherwise discover one sign-in at a time later. The
 * rule holds unconditionally because the pair is shared with the api, and a worker that
 * starts with an id and no secret is never what anyone meant.
 *
 * The messages name variables only, never the value that was set: half a pair is a
 * credential, and a startup error must not be the way it reaches a log store.
 */
function pairOrOff(
  raw: NodeJS.ProcessEnv,
  idName: string,
  secretName: string,
): { id: string; secret: string } | undefined {
  const id = optional(raw, idName)
  const secret = optional(raw, secretName)

  if (id === undefined && secret === undefined) return undefined
  if (id === undefined) {
    throw new Error(
      `${secretName} is set but ${idName} is not; set both to turn Twitch on, or neither to leave it off`,
    )
  }
  if (secret === undefined) {
    throw new Error(
      `${idName} is set but ${secretName} is not; ` +
        'set both to turn Twitch on, or neither to leave it off',
    )
  }
  return { id, secret }
}

/**
 * The key grants are sealed with, checked as bytes rather than as text.
 *
 * `Buffer.from(..., 'base64')` silently drops characters it cannot decode, so a mistyped
 * key would otherwise become a shorter key that still "works" until every stored grant
 * fails to open. The length is the only check that turns that into a startup error, and
 * the message reports the length found, never the key.
 */
function tokenKey(raw: NodeJS.ProcessEnv): string | undefined {
  const value = optional(raw, 'PLATFORM_TOKEN_KEY')
  if (value === undefined) return undefined
  const bytes = Buffer.from(value, 'base64').length
  if (bytes !== TOKEN_KEY_BYTES) {
    throw new Error(
      `PLATFORM_TOKEN_KEY must be base64 of exactly ${TOKEN_KEY_BYTES} bytes ` +
        `(openssl rand -base64 32); got ${bytes} bytes`,
    )
  }
  return value
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
  const hasTwitch = connectorNames.includes('twitch')

  // The connector list is parsed above, so an unknown name has already failed: an operator
  // who typed `twitchh` gets that error, not a missing credential. Twitch is then checked
  // before the stub switches, because half a credential pair is the mistake most worth
  // naming first.
  const twitchPair = pairOrOff(raw, 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET')
  if (twitchPair === undefined && hasTwitch) {
    // Discovery was asked for and neither half is set. There is no useful "which half"
    // question to answer here, so one message names both.
    throw new Error(
      'PLATFORM_CONNECTORS lists "twitch" but TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET ' +
        'are not set; set both, plus TWITCH_CHANNEL_LOGIN, TWITCH_CHANNEL_REFRESH_TOKEN ' +
        'and PLATFORM_TOKEN_KEY',
    )
  }
  // A key of the wrong length is always wrong, listed or not; a missing key only matters
  // when discovery is on and the channel grant has to be sealed.
  const platformTokenKey =
    tokenKey(raw) ?? (hasTwitch ? required(raw, 'PLATFORM_TOKEN_KEY') : undefined)

  const twitchConfig: Pick<
    WorkerEnv,
    | 'TWITCH_CLIENT_ID'
    | 'TWITCH_CLIENT_SECRET'
    | 'TWITCH_CHANNEL_LOGIN'
    | 'TWITCH_CHANNEL_REFRESH_TOKEN'
    | 'PLATFORM_TOKEN_KEY'
  > = {}
  // Each value is assigned only when set, so `Object.keys` on the result stays an honest
  // list of what the process was actually given.
  if (twitchPair !== undefined) {
    twitchConfig.TWITCH_CLIENT_ID = twitchPair.id
    twitchConfig.TWITCH_CLIENT_SECRET = twitchPair.secret
  }
  const twitchChannelLogin = hasTwitch
    ? required(raw, 'TWITCH_CHANNEL_LOGIN')
    : optional(raw, 'TWITCH_CHANNEL_LOGIN')
  if (twitchChannelLogin !== undefined) twitchConfig.TWITCH_CHANNEL_LOGIN = twitchChannelLogin
  const twitchRefreshToken = hasTwitch
    ? required(raw, 'TWITCH_CHANNEL_REFRESH_TOKEN')
    : optional(raw, 'TWITCH_CHANNEL_REFRESH_TOKEN')
  if (twitchRefreshToken !== undefined) {
    twitchConfig.TWITCH_CHANNEL_REFRESH_TOKEN = twitchRefreshToken
  }
  if (platformTokenKey !== undefined) twitchConfig.PLATFORM_TOKEN_KEY = platformTokenKey

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
    ...twitchConfig,
  }
}
