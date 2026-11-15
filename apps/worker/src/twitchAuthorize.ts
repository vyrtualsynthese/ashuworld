/**
 * The one-time channel authorization.
 *
 * Sign-in for fans uses the fan's own grant and the `user:read:follows` scope. Reading the
 * channel's follower list is different: Twitch only answers it to an account that may
 * moderate the channel, so the channel owner has to grant `moderator:read:followers` by
 * hand, once, as themselves. This command is that hand-off and nothing else. It prints a
 * URL, waits for the redirect on loopback, exchanges the code and prints the refresh
 * token. It never writes a file or the database: the operator pastes the token into `.env`
 * as `TWITCH_CHANNEL_REFRESH_TOKEN`, which is the only copy that should exist outside the
 * worker's sealed store.
 *
 * Everything here is a plain `node:http` server and the global `fetch`; no dependency, and
 * no framework, because a command run once by hand does not need either. The two network
 * edges — the authorize URL and the token exchange — are exported and take their inputs as
 * arguments so the test never opens a socket or touches Twitch.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'

/**
 * The one scope the command asks for. It lets the worker read the channel's follower list;
 * it grants no chat write, no stream key and nothing about any other channel.
 */
const CHANNEL_SCOPE = 'moderator:read:followers'

/**
 * The redirect the operator registers on the Twitch application.
 *
 * It is fixed and loopback-only on purpose: the code comes back to the machine running the
 * command, never through a public endpoint, and the port is the one the command opens
 * below. Twitch compares this string byte for byte against what the app registered.
 */
export const TWITCH_CHANNEL_REDIRECT_URI = 'http://localhost:17563/twitch/callback'

const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PORT = 17_563
const CALLBACK_PATH = '/twitch/callback'

/** Where the operator revokes a grant that has already been spent or mis-scoped. */
const CONNECTIONS_PAGE = 'https://www.twitch.tv/settings/connections'

/** The two application variables this command needs. The channel's own token is not one. */
export interface TwitchAppEnv {
  TWITCH_CLIENT_ID?: string | undefined
  TWITCH_CLIENT_SECRET?: string | undefined
}

type RequiredName = 'TWITCH_CLIENT_ID' | 'TWITCH_CLIENT_SECRET'

/**
 * A required variable, or an error naming it. Empty counts as missing, the same rule the
 * worker applies to `DATABASE_URL`, and the value is trimmed so a stray space from a shell
 * copy does not become part of the client id.
 */
function required(env: TwitchAppEnv, name: RequiredName): string {
  const value = env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is required but was not set; export it before running the command`,
    )
  }
  return value.trim()
}

/**
 * The `state` the callback must echo back: 32 random bytes, base64url.
 *
 * The state is what makes the callback this run's callback. Without it, any page could hit
 * the loopback port with somebody else's code and have the operator's app exchange it into
 * a grant. One value per run, compared with `!==` below; there is no store because there is
 * only ever one run in flight.
 */
function randomState(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The URL the channel owner opens. The second argument exists so `main` keeps the state it
 * generated; a caller that passes nothing gets a fresh random one.
 */
export function twitchAuthorizeUrl(env: TwitchAppEnv, state: string = randomState()): string {
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', required(env, 'TWITCH_CLIENT_ID'))
  url.searchParams.set('redirect_uri', TWITCH_CHANNEL_REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', CHANNEL_SCOPE)
  url.searchParams.set('state', state)
  return url.toString()
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

/** A JSON object from the token response, or `undefined` when Twitch answered something else. */
function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    return objectOf(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/**
 * The refresh token a code is worth.
 *
 * Twitch rotates the code and returns a refresh token only when the app is a confidential
 * client — one with a secret — which is why the secret is posted here and never in the
 * browser flow. Missing the refresh token is not a partial success: the access token would
 * expire in hours and the worker would be back to the start, so this fails loudly and tells
 * the operator to disconnect the app, which is the only way to clear a grant that was
 * already issued under a different scope, and run the command again.
 */
export async function exchangeTwitchCode(
  env: TwitchAppEnv,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string }> {
  const clientId = required(env, 'TWITCH_CLIENT_ID')
  const clientSecret = required(env, 'TWITCH_CLIENT_SECRET')

  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: TWITCH_CHANNEL_REDIRECT_URI,
    }),
  })
  const raw = await response.text()

  if (!response.ok) {
    const detail = raw.trim() === '' ? '' : `: ${raw.trim().slice(0, 200)}`
    throw new Error(
      `Twitch refused the code exchange with HTTP ${response.status}${detail}; the code is ` +
        `single-use, so disconnect the app at ${CONNECTIONS_PAGE} and run the command again`,
    )
  }

  const refreshToken = parseObject(raw)?.['refresh_token']
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new Error(
      'Twitch answered the code exchange without a refresh_token, so there would be no ' +
        `grant to keep; disconnect the app at ${CONNECTIONS_PAGE} and run the command again`,
    )
  }
  return { refreshToken }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error)
}

/** A plain-text page, closing the connection so the one-shot server can stop. */
function respond(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    connection: 'close',
  })
  response.end(`${message}\n`)
}

/** The path and query of a callback request, or `/` for a request without a URL. */
function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', TWITCH_CHANNEL_REDIRECT_URI)
}

/** Binds the callback port, or rejects with the socket's reason (a busy port, usually). */
function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

/** A verdict from `classifyCallback`: the code to exchange, or why the run stops here. */
export type CallbackVerdict =
  | { kind: 'code'; code: string }
  | { kind: 'refused'; reason: string; page: string }

/**
 * What a callback means, decided in one place so the order can be tested without a socket.
 *
 * **The state is checked first, before anything else in the query is read.** That ordering
 * is the whole security property: without it, any local traffic could hit the port with
 * `?error=x` and end the run, which is a denial of service on the one setup the operator
 * cannot redo without Twitch's page. A request whose state does not match this run is
 * refused whether it carries an `error`, a `code`, or neither; a matching state is what
 * lets an error or a code be acted on. The code path keeps the same check: a code is
 * returned only when the state matched exactly.
 */
export function classifyCallback(
  query: URLSearchParams,
  expectedState: string,
): CallbackVerdict {
  if (query.get('state') !== expectedState) {
    return {
      kind: 'refused',
      page: 'The callback did not come from this run; nothing was exchanged.',
      reason:
        'the callback state did not match this run, so nothing was exchanged; ' +
        'start the command again and use the URL it prints',
    }
  }

  const refusal = query.get('error')
  if (refusal !== null) {
    const description = query.get('error_description')
    const said = description === null ? '' : ` (${description})`
    return {
      kind: 'refused',
      page: 'Twitch refused the authorization; the terminal says why.',
      reason: `Twitch refused the authorization: ${refusal}${said}`,
    }
  }

  const code = query.get('code')
  if (code === null || code === '') {
    return {
      kind: 'refused',
      page: 'Twitch redirected back without a code; run the command again.',
      reason: 'Twitch redirected back without a code',
    }
  }

  return { kind: 'code', code }
}

/**
 * Prints the URL, waits for Twitch to redirect the browser back, and returns the code.
 *
 * Only `CALLBACK_PATH` is answered; anything else on the port (a browser asking for
 * `/favicon.ico`, a port scanner) gets a 404 and does not end the wait. The decision itself
 * lives in `classifyCallback`, which checks the state before it reads anything else. The
 * server closes in `finally`, so a refusal or a thrown exchange cannot leave the port bound.
 */
async function waitForCode(state: string, authorizeUrl: string): Promise<string> {
  const server = createServer()
  try {
    await listen(server)

    console.log(
      '[twitch-authorize] open this link as the channel owner — the Twitch account that ' +
        'owns the channel, not a moderator and not a bot:',
    )
    console.log(authorizeUrl)
    console.log(`[twitch-authorize] waiting for the redirect on ${TWITCH_CHANNEL_REDIRECT_URI}`)

    return await new Promise<string>((resolve, reject) => {
      let settled = false
      const settle = (finish: () => void): void => {
        if (settled) return
        settled = true
        finish()
      }

      server.on('error', (error) => settle(() => reject(error)))

      server.on('request', (request, response) => {
        const requested = requestUrl(request)
        if (requested.pathname !== CALLBACK_PATH) {
          respond(response, 404, 'Not found.')
          return
        }
        if (settled) {
          respond(response, 409, 'This authorization already finished; close this tab.')
          return
        }

        const verdict = classifyCallback(requested.searchParams, state)
        if (verdict.kind === 'refused') {
          respond(response, 400, verdict.page)
          settle(() => reject(new Error(verdict.reason)))
          return
        }

        respond(
          response,
          200,
          'The code reached the command. You can close this tab; the terminal prints the result.',
        )
        settle(() => resolve(verdict.code))
      })
    })
  } finally {
    server.close()
  }
}

/**
 * The command. Returns the exit code instead of calling `process.exit`, so the shell keeps
 * ownership of the process and a test can assert the refusal without a socket.
 *
 * Neither variable is looked up here beyond the validation: `required` names the missing one
 * in the message, and a non-zero exit is the only useful answer for a command that can do
 * nothing without it.
 */
export async function main(env: TwitchAppEnv = process.env): Promise<number> {
  try {
    const clientId = required(env, 'TWITCH_CLIENT_ID')
    const clientSecret = required(env, 'TWITCH_CLIENT_SECRET')

    const state = randomState()
    const authorizeUrl = twitchAuthorizeUrl({ TWITCH_CLIENT_ID: clientId }, state)
    const code = await waitForCode(state, authorizeUrl)
    const { refreshToken } = await exchangeTwitchCode(
      { TWITCH_CLIENT_ID: clientId, TWITCH_CLIENT_SECRET: clientSecret },
      code,
    )

    console.log(`TWITCH_CHANNEL_REFRESH_TOKEN=${refreshToken}`)
    console.log('[twitch-authorize] paste that line into .env and restart the worker.')
    return 0
  } catch (error) {
    console.error(`[twitch-authorize] ${messageOf(error)}`)
    return 1
  }
}

// Only when run as a command (`pnpm --filter @ashuworld/worker twitch-authorize`). Importing
// the module to test its two exported network edges must not print, listen or exit.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main()
}
