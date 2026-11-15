import type { Pool } from 'pg'
import type { DiscoveredPerson } from '@ashuworld/providers'
import type { WorkerEnv } from '../config.js'
import type { Connector } from './types.js'
import { getTwitchAccessToken } from './twitchToken.js'

/**
 * The Twitch follower connector.
 *
 * Twitch only answers a channel's follower list to an account that may moderate it, so this
 * reads with the channel owner's grant (staged by `twitch-authorize`) and never with a
 * fan's sign-in. The grant lives sealed in `platform_tokens`; `getTwitchAccessToken` is the
 * one place that opens it.
 *
 * A run is two steps: resolve the broadcaster id from `TWITCH_CHANNEL_LOGIN`, then page the
 * follower list 100 at a time. The id is resolved once per call rather than per page, and
 * the login, not the id, is the configuration value because an operator knows the channel's
 * name and not its numeric id.
 *
 * Any failure throws and the runner catches it per connector: a Twitch outage leaves the
 * other sources running and this one retries next tick. Pages yielded before the failure
 * are real followers and stay enqueued; the failed page yields nothing.
 */

const HELIX = 'https://api.twitch.tv/helix'

/** Twitch's maximum for this endpoint. Fewer followers means fewer round trips. */
const PAGE_SIZE = 100

/** The one action a follower proves. */
const FOLLOW_ACTION = 'twitch.follow'

export interface TwitchConnectorOptions {
  pool: Pool
  env: WorkerEnv
  fetchImpl?: typeof fetch
}

/** A required setting, or an error naming it. The connector is only built when config allowed it. */
function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is required to read the Twitch follower list but was not set; ` +
        'it is checked at startup when PLATFORM_CONNECTORS lists "twitch"',
    )
  }
  return value.trim()
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** One follower as the endpoint returns it; every field is optional because the wire is not ours. */
interface FollowerRow {
  user_id?: unknown
  user_login?: unknown
  user_name?: unknown
}

interface FollowerPage {
  data?: unknown
  pagination?: unknown
}

interface UserEntry {
  id?: unknown
}

interface HelixCall {
  fetchImpl: typeof fetch
  accessToken: string
  clientId: string
  /** A noun for the error message: which call Twitch refused. */
  what: string
}

/**
 * A parsed Helix response.
 *
 * A non-2xx is the caller-side failure this connector reports: the status goes in the
 * message so an operator can tell an expired grant (401) from a rate limit (429) from an
 * outage (5xx). The body is a short detail, never a token.
 */
async function helixJson<T>(call: HelixCall, url: URL): Promise<T> {
  const response = await call.fetchImpl(url, {
    headers: {
      'Client-Id': call.clientId,
      Authorization: `Bearer ${call.accessToken}`,
    },
  })
  const raw = await response.text()

  if (!response.ok) {
    const detail = raw.trim() === '' ? '' : `: ${raw.trim().slice(0, 200)}`
    throw new Error(
      `Twitch refused the ${call.what} with HTTP ${response.status}${detail}; ` +
        'discovery retries this connector on the next round',
    )
  }

  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`Twitch answered the ${call.what} with something that is not JSON`)
  }
}

/** The channel's numeric id, which the follower endpoint takes instead of the login. */
async function resolveBroadcaster(call: HelixCall, channelLogin: string): Promise<string> {
  const url = new URL(`${HELIX}/users`)
  url.searchParams.set('login', channelLogin)
  const body = await helixJson<{ data?: UserEntry[] }>(call, url)
  const id = textOf(body.data?.[0]?.id)
  if (id === undefined) {
    // Not a transient failure: no retry will make the channel exist. The message names the
    // value to fix, so an operator does not have to guess which variable is wrong.
    throw new Error(
      `Twitch knows no user with the login "${channelLogin}"; check TWITCH_CHANNEL_LOGIN`,
    )
  }
  return id
}

interface FollowersPage {
  rows: FollowerRow[]
  /** The cursor for the next page, absent on the last one. */
  cursor?: string
}

async function fetchFollowersPage(
  call: HelixCall,
  broadcasterId: string,
  cursor: string | undefined,
): Promise<FollowersPage> {
  const url = new URL(`${HELIX}/channels/followers`)
  url.searchParams.set('broadcaster_id', broadcasterId)
  url.searchParams.set('first', String(PAGE_SIZE))
  if (cursor !== undefined) url.searchParams.set('after', cursor)

  const body = await helixJson<FollowerPage>(call, url)
  if (!Array.isArray(body.data)) {
    throw new Error(`Twitch answered the ${call.what} without a data array`)
  }
  const pagination = body.pagination
  const next =
    typeof pagination === 'object' && pagination !== null
      ? textOf((pagination as { cursor?: unknown }).cursor)
      : undefined

  return {
    rows: body.data as FollowerRow[],
    ...(next === undefined ? {} : { cursor: next }),
  }
}

/**
 * One follower as a person, or an error naming the field.
 *
 * The queue's payload validator refuses an empty string later, where the failure would be
 * attributed to the queue rather than to the source. Checking here keeps the diagnosis on
 * the connector and stops a half-formed person from being enqueued.
 */
function followerToPerson(row: FollowerRow): DiscoveredPerson {
  const externalId = textOf(row.user_id)
  const displayHandle = textOf(row.user_login)
  const displayName = textOf(row.user_name)
  if (externalId === undefined || displayHandle === undefined || displayName === undefined) {
    throw new Error(
      'Twitch answered the follower list with an entry missing user_id, user_login or user_name',
    )
  }
  return {
    provider: 'twitch',
    externalId,
    displayHandle,
    displayName,
    actions: [FOLLOW_ACTION],
  }
}

/**
 * Builds the connector from a validated environment.
 *
 * All five Twitch settings are read once, at construction, so a misconfigured process fails
 * while starting rather than on every discovery round. `loadWorkerEnv` has already required
 * them when `'twitch'` is listed; the checks here are what a hand-built environment gets.
 */
export function createTwitchConnector(options: TwitchConnectorOptions): Connector {
  const { pool, env } = options
  const fetchImpl = options.fetchImpl ?? fetch

  const clientId = required(env.TWITCH_CLIENT_ID, 'TWITCH_CLIENT_ID')
  const clientSecret = required(env.TWITCH_CLIENT_SECRET, 'TWITCH_CLIENT_SECRET')
  const channelLogin = required(env.TWITCH_CHANNEL_LOGIN, 'TWITCH_CHANNEL_LOGIN')
  const key = required(env.PLATFORM_TOKEN_KEY, 'PLATFORM_TOKEN_KEY')
  const envToken = env.TWITCH_CHANNEL_REFRESH_TOKEN

  return {
    name: 'twitch',
    async *discover() {
      const accessToken = await getTwitchAccessToken({
        pool,
        clientId,
        clientSecret,
        key,
        fetchImpl,
        ...(envToken === undefined ? {} : { envToken }),
      })
      const call: HelixCall = {
        fetchImpl,
        accessToken,
        clientId,
        what: 'follower list',
      }

      const broadcasterId = await resolveBroadcaster({ ...call, what: 'broadcaster lookup' }, channelLogin)

      let cursor: string | undefined
      do {
        const page = await fetchFollowersPage(call, broadcasterId, cursor)
        for (const row of page.rows) yield followerToPerson(row)
        cursor = page.cursor
      } while (cursor !== undefined)
    },
  }
}
