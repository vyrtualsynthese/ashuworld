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
}

const DEFAULT_SESSION_COOKIE_NAME = 'ashuworld_session'
const DEFAULT_PORT = 3000

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
  }
}
