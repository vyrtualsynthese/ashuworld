/**
 * The process configuration the api reads at startup.
 *
 * Everything that has a safe default does; `DATABASE_URL` and `PUBLIC_BASE_URL` do not,
 * because a service that starts without them is misconfigured in a way no later request
 * can repair. The values are parsed once, outside `buildServer`, so tests can hand the
 * server a plain object and never touch `process.env`.
 */
export interface Env {
  DATABASE_URL: string
  SESSION_COOKIE_NAME: string
  COOKIE_SECURE: boolean
  ALLOW_DEV_LOGIN: boolean
  /**
   * Whether `X-Forwarded-For` may decide `request.ip`.
   *
   * Off by default: trusting the header without a proxy in front lets any caller choose
   * the address in the log. A deployment behind a reverse proxy or a Kubernetes ingress
   * must set `TRUST_PROXY=true`, or every request is logged with the proxy's address.
   */
  TRUST_PROXY: boolean
  PUBLIC_BASE_URL: string
  PORT: number
  /** Whether the rate limiter runs at all. Off in tests, on everywhere else. */
  RATE_LIMIT_ENABLED: boolean
  /** The length of the window every bucket counts over, in milliseconds. */
  RATE_LIMIT_WINDOW_MS: number
  /** Requests allowed per window on an ordinary route. */
  RATE_LIMIT_PUBLIC_MAX: number
  /** Requests allowed per window on a sign-in or sign-out route. */
  RATE_LIMIT_AUTH_MAX: number
  /** Requests allowed per window on a destructive write. */
  RATE_LIMIT_WRITE_MAX: number
  /**
   * Pino log level. Optional so tests and callers that build a server directly keep the
   * default; the process entry point reads it from `LOG_LEVEL`, and a development stack
   * sets it to `debug` to see the request and error detail.
   */
  LOG_LEVEL?: LogLevel
}

/** The levels pino accepts. Kept explicit so a typo fails at startup, not silently at run time. */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent'

const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']
const DEFAULT_LOG_LEVEL: LogLevel = 'info'

const DEFAULT_SESSION_COOKIE_NAME = 'ashuworld_session'
const DEFAULT_PORT = 3000
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000
const DEFAULT_RATE_LIMIT_PUBLIC_MAX = 120
const DEFAULT_RATE_LIMIT_AUTH_MAX = 20
const DEFAULT_RATE_LIMIT_WRITE_MAX = 10

/** A required variable, or a plain error that names it. Empty is missing, and the value is trimmed. */
function required(raw: NodeJS.ProcessEnv, name: string): string {
  const value = raw[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is required but was not set; export it before starting the api`,
    )
  }
  return value.trim()
}

/**
 * A boolean variable. Only `true`/`false` (any case) are accepted: a typo such as
 * `yes` would otherwise silently mean `false`, and `COOKIE_SECURE` being silently off
 * is exactly the mistake that should stop the deployment.
 */
function flag(raw: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = raw[name]
  if (value === undefined || value.trim() === '') return fallback
  const normalised = value.trim().toLowerCase()
  if (normalised === 'true') return true
  if (normalised === 'false') return false
  throw new Error(`${name} must be "true" or "false", got ${JSON.stringify(value)}`)
}

/** The listening port, defaulting to 3000. Rejects anything not a real TCP port. */
function port(raw: NodeJS.ProcessEnv): number {
  const value = raw['PORT']
  if (value === undefined || value.trim() === '') return DEFAULT_PORT
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(value)}`)
  }
  return parsed
}

/**
 * A positive whole number, or a startup error naming the variable. The rate-limit values
 * use this: a fractional, zero or negative budget would either distort the limiter or,
 * with zero, lock every caller out, so it must not pass silently.
 */
function positiveInteger(raw: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = raw[name]
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}

/** The pino level, defaulting to `info`. An unknown level is a startup error, not a silent `info`. */
function logLevel(raw: NodeJS.ProcessEnv): LogLevel {
  const value = raw['LOG_LEVEL']
  if (value === undefined || value.trim() === '') return DEFAULT_LOG_LEVEL
  const normalised = value.trim().toLowerCase()
  if (!(LOG_LEVELS as readonly string[]).includes(normalised)) {
    throw new Error(
      `LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(value)}`,
    )
  }
  return normalised as LogLevel
}

/**
 * Reads the environment. Takes `raw` so a test can prove the defaults without mutating
 * the process it runs in; the default argument is what `src/index.ts` uses.
 *
 * `COOKIE_SECURE` defaults from `PUBLIC_BASE_URL` rather than to `false`: a deployment
 * behind TLS that forgets the variable must still get a `Secure` identity cookie. An
 * explicit `COOKIE_SECURE=false` still wins, because local development and the test suite
 * speak plain HTTP on purpose.
 */
export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const databaseUrl = required(raw, 'DATABASE_URL')
  const publicBaseUrl = required(raw, 'PUBLIC_BASE_URL')
  const sessionCookieName = raw['SESSION_COOKIE_NAME']

  return {
    DATABASE_URL: databaseUrl,
    SESSION_COOKIE_NAME:
      sessionCookieName === undefined || sessionCookieName.trim() === ''
        ? DEFAULT_SESSION_COOKIE_NAME
        : sessionCookieName,
    COOKIE_SECURE: flag(raw, 'COOKIE_SECURE', publicBaseUrl.toLowerCase().startsWith('https://')),
    ALLOW_DEV_LOGIN: flag(raw, 'ALLOW_DEV_LOGIN', false),
    TRUST_PROXY: flag(raw, 'TRUST_PROXY', false),
    PUBLIC_BASE_URL: publicBaseUrl,
    PORT: port(raw),
    RATE_LIMIT_ENABLED: flag(raw, 'RATE_LIMIT_ENABLED', true),
    RATE_LIMIT_WINDOW_MS: positiveInteger(
      raw,
      'RATE_LIMIT_WINDOW_MS',
      DEFAULT_RATE_LIMIT_WINDOW_MS,
    ),
    RATE_LIMIT_PUBLIC_MAX: positiveInteger(
      raw,
      'RATE_LIMIT_PUBLIC_MAX',
      DEFAULT_RATE_LIMIT_PUBLIC_MAX,
    ),
    RATE_LIMIT_AUTH_MAX: positiveInteger(raw, 'RATE_LIMIT_AUTH_MAX', DEFAULT_RATE_LIMIT_AUTH_MAX),
    RATE_LIMIT_WRITE_MAX: positiveInteger(
      raw,
      'RATE_LIMIT_WRITE_MAX',
      DEFAULT_RATE_LIMIT_WRITE_MAX,
    ),
    LOG_LEVEL: logLevel(raw),
  }
}
