import type { IdentityProfile } from '@ashuworld/providers'
import {
  ProviderExchangeError,
  type AuthorizeInput,
  type ExchangeInput,
  type ExchangeResult,
  type OAuthProvider,
} from '../providers.js'

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize'
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'
const HELIX = 'https://api.twitch.tv/helix'

/**
 * The one scope the sign-in asks for: the follow list of the account signing in.
 *
 * Nothing here reads chat, a stream key, or any channel the fan does not own.
 */
const SCOPE = 'user:read:follows'

/** The action the follow check proves. It must name an action the game config awards. */
const FOLLOW_ACTION = 'twitch.follow'

/**
 * How many pages of follows to read before giving up.
 *
 * Twitch has no "does A follow B" endpoint, so the list has to be walked one page at a
 * time. The cap keeps a fan following thousands — or an API that keeps handing back the
 * same cursor — from holding the callback open. Twenty pages is 2000 follows.
 */
const MAX_FOLLOW_PAGES = 20

export interface TwitchProviderOptions {
  clientId: string
  clientSecret: string
  /** The Twitch login the follow is checked against, e.g. `ashuworld`. */
  channelLogin: string
  /** Injected by tests; production keeps the global fetch. */
  fetchImpl?: typeof fetch
}

type JsonObject = Record<string, unknown>

function objectOf(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonObject) : undefined
}

/**
 * Reads a response body as a JSON object.
 *
 * Twitch answers some refusals as a redirect, an HTML error page or an empty body. Here
 * those are all "no usable body"; each caller turns that into the answer matching what it
 * was doing, so the parse failure is folded into `undefined` instead of thrown.
 */
async function readJsonObject(response: Response): Promise<JsonObject | undefined> {
  try {
    return objectOf(await response.json())
  } catch {
    return undefined
  }
}

/** The access token a code is worth, or a 4xx because the fan's sign-in was refused. */
async function exchangeCode(
  doFetch: typeof fetch,
  options: TwitchProviderOptions,
  input: ExchangeInput,
): Promise<string> {
  const response = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: input.code,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    }),
  })

  // A 4xx here is the fan's code being stale, reused or issued to someone else, which is
  // the fan's problem to retry. A 5xx is Twitch's, and a retry is the same answer, so it
  // is also reported as a refused sign-in rather than as this service failing.
  if (!response.ok) throw new ProviderExchangeError('twitch refused the sign-in', 400)

  const body = await readJsonObject(response)
  const accessToken = body?.['access_token']
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new ProviderExchangeError('twitch refused the sign-in', 400)
  }
  return accessToken
}

/** The account behind a token, or a 502 because Twitch answered without one. */
async function readProfile(
  doFetch: typeof fetch,
  options: TwitchProviderOptions,
  accessToken: string,
): Promise<IdentityProfile> {
  const response = await doFetch(`${HELIX}/users`, {
    headers: { 'client-id': options.clientId, authorization: `Bearer ${accessToken}` },
  })

  // Unlike the code exchange, this is a read of an account that already authenticated:
  // a refusal here means the token or the app is wrong, which is this deployment's
  // problem, not the fan's. It must not be reported as a bad sign-in.
  const body = response.ok ? await readJsonObject(response) : undefined
  const rows = Array.isArray(body?.['data']) ? body['data'] : []
  const user = objectOf(rows[0])
  const id = user?.['id']
  const login = user?.['login']
  if (typeof id !== 'string' || typeof login !== 'string') {
    throw new ProviderExchangeError('twitch returned no account', 502)
  }

  const displayName = user?.['display_name']
  return {
    provider: 'twitch',
    externalId: id,
    displayHandle: login,
    displayName: typeof displayName === 'string' && displayName !== '' ? displayName : login,
  }
}

/**
 * Whether the account follows the configured channel, read from Twitch's follow list.
 *
 * A refusal on this read is not a failed sign-in: the identity is already proved at this
 * point, so the fan signs in and simply earns no follow action. Nothing is logged, because
 * a refusal here is an ordinary answer (the grant can be revoked between the two calls).
 */
async function followsChannel(
  doFetch: typeof fetch,
  options: TwitchProviderOptions,
  accessToken: string,
  userId: string,
): Promise<boolean> {
  const wanted = options.channelLogin.toLowerCase()
  let after: string | undefined

  for (let page = 0; page < MAX_FOLLOW_PAGES; page += 1) {
    const url = new URL(`${HELIX}/channels/followed`)
    url.searchParams.set('user_id', userId)
    url.searchParams.set('first', '100')
    if (after !== undefined) url.searchParams.set('after', after)

    const response = await doFetch(url.toString(), {
      headers: { 'client-id': options.clientId, authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) return false

    const body = await readJsonObject(response)
    if (body === undefined) return false

    const rows = Array.isArray(body['data']) ? body['data'] : []
    for (const row of rows) {
      const login = objectOf(row)?.['broadcaster_login']
      if (typeof login === 'string' && login.toLowerCase() === wanted) return true
    }

    const cursor = objectOf(body['pagination'])?.['cursor']
    if (typeof cursor !== 'string' || cursor === '') return false
    after = cursor
  }

  return false
}

/**
 * The Twitch sign-in provider.
 *
 * Twitch is where the fans already are, so it is the first real door. The grant is used
 * once, on the callback, to read who signed in and whether they follow the channel; it is
 * then dropped. Nothing long-lived is stored for the fan, so a leaked database cannot
 * become a leaked Twitch account.
 */
export function createTwitchProvider(options: TwitchProviderOptions): OAuthProvider {
  const doFetch = options.fetchImpl ?? fetch

  return {
    name: 'twitch',

    authorizeUrl({ state, redirectUri }: AuthorizeInput): string {
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('client_id', options.clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', SCOPE)
      url.searchParams.set('state', state)
      return url.toString()
    },

    async exchange(input: ExchangeInput): Promise<ExchangeResult> {
      const accessToken = await exchangeCode(doFetch, options, input)
      const profile = await readProfile(doFetch, options, accessToken)
      const followed = await followsChannel(doFetch, options, accessToken, profile.externalId)

      // No refreshToken: this grant is a fan's, used once. Plan 4 keeps one only where a
      // later re-check needs it.
      return { profile, verifiedActions: followed ? [FOLLOW_ACTION] : [] }
    },
  }
}
