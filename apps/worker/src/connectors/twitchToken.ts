import type { Pool } from 'pg'
import { readPlatformToken, writePlatformToken } from '@ashuworld/ledger'
import { openToken, sealToken } from '@ashuworld/providers'

/**
 * The channel owner's grant, from the sealed row to a usable access token.
 *
 * Twitch access tokens last about an hour, so the worker cannot keep one in the environment
 * and it cannot simply reuse the refresh token it would be handed: Twitch rotates the
 * refresh token on some refreshes, and the only safe place for the current one is the
 * sealed `platform_tokens` row. This module is the only place that opens that row.
 *
 * Plaintext exists in three places and nowhere else: the refresh request's body, the
 * access token in memory, and the value just unsealed. Every write to the database goes
 * through `sealToken`, so a dump or a reader of the table learns nothing.
 */

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token'

/**
 * Twitch access tokens live about an hour. Refreshing a minute early keeps a run from
 * starting on a token that dies between the first page and the last.
 */
const EXPIRY_MARGIN_MS = 60_000

export interface TwitchTokenDeps {
  pool: Pool
  clientId: string
  clientSecret: string
  /** The refresh token from `TWITCH_CHANNEL_REFRESH_TOKEN`; used only to seed an empty table. */
  envToken?: string
  /** The base64 `PLATFORM_TOKEN_KEY` the row is sealed with. */
  key: string
  fetchImpl?: typeof fetch
  /** Milliseconds. Injected so a test can age the cache instead of sleeping an hour. */
  now?: () => number
}

/** One access token and the instant it stops being usable. */
interface CachedToken {
  accessToken: string
  expiresAt: number
}

/**
 * Access tokens already refreshed, keyed `clientId:refreshToken`.
 *
 * Module-level because the connector instance is long-lived and a discovery round may read
 * several pages; the map is process-wide so two connectors of the same app share it. The
 * refresh token is part of the key so a rotation produces a new entry instead of serving
 * the access token of a grant that no longer exists. Nothing exported clears it: a test
 * avoids the cache with a unique client id and `now`, not with a reset hook that production
 * code would then carry.
 */
const cache = new Map<string, CachedToken>()

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** A non-empty string field, or `undefined`; Twitch sends identifiers as strings. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    return objectOf(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/** A short slice of an error body for the message, or nothing when it was empty. */
function detailOf(raw: string): string {
  const trimmed = raw.trim()
  return trimmed === '' ? '' : `: ${trimmed.slice(0, 200)}`
}

/**
 * Seals the environment token into an empty table, so the row exists before the first
 * refresh has anything to rotate.
 *
 * The message names the variable because that is the one thing an operator can act on.
 * It never echoes the value: the variable is a credential.
 */
async function seed(pool: Pool, envToken: string | undefined, key: string): Promise<string> {
  if (envToken === undefined || envToken === '') {
    throw new Error(
      'no Twitch grant is stored and TWITCH_CHANNEL_REFRESH_TOKEN is not set; ' +
        'run twitch-authorize, put the token in .env and start the worker again',
    )
  }
  await writePlatformToken(pool, 'twitch', sealToken(envToken, key))
  return envToken
}

/**
 * The stored refresh token.
 *
 * A row that will not open is a configuration error, not a reason to fall back to the
 * environment: the environment value may be the stale one the row replaced, and overwriting
 * a good row with it would throw away the only current grant. So this throws, names the
 * variable, and leaves the row untouched. The original error is the cause, not the message:
 * the crypto layer's messages never carry the token, but keeping them out of the visible
 * sentence keeps the instruction the operator needs first.
 */
function unsealOrThrow(sealed: string, key: string): string {
  try {
    return openToken(sealed, key)
  } catch (error) {
    throw new Error(
      'the stored Twitch grant cannot be opened; set the matching PLATFORM_TOKEN_KEY, or ' +
        'delete the stored twitch row in platform_tokens and authorize the channel again',
      { cause: error },
    )
  }
}

interface RefreshInput {
  fetchImpl: typeof fetch
  clientId: string
  clientSecret: string
  refreshToken: string
  now: () => number
}

interface RefreshedGrant {
  accessToken: string
  expiresAt: number
  /** Present only when Twitch rotated it; absent means the stored one is still current. */
  refreshToken?: string
}

/**
 * Spends the refresh token for an access token.
 *
 * A missing `expires_in` is treated as "no cache": the next call refreshes again. That is
 * slower but never serves a token past its life, which is the failure that would otherwise
 * look like a broken connector.
 */
async function refreshGrant(input: RefreshInput): Promise<RefreshedGrant> {
  const response = await input.fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    }),
  })
  const raw = await response.text()

  if (!response.ok) {
    throw new Error(
      `Twitch refused the grant refresh with HTTP ${response.status}${detailOf(raw)}; ` +
        'the channel owner may have revoked the app, so run twitch-authorize again',
    )
  }

  const body = parseObject(raw)
  const accessToken = textOf(body?.['access_token'])
  if (accessToken === undefined) {
    throw new Error(
      'Twitch answered the grant refresh without an access_token; ' +
        'run twitch-authorize again to replace the grant',
    )
  }

  const expiresIn = body?.['expires_in']
  const lifetimeMs =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 0
  const rotated = textOf(body?.['refresh_token'])

  return {
    accessToken,
    expiresAt: input.now() + lifetimeMs - EXPIRY_MARGIN_MS,
    ...(rotated === undefined ? {} : { refreshToken: rotated }),
  }
}

/**
 * A usable access token for the channel grant, refreshed and cached as needed.
 *
 * Each call reads the row so a rotation written by another process is seen immediately.
 * Only the network refresh is cached: the read is one indexed row and keeps the database
 * as the source of truth for the refresh token.
 */
export async function getTwitchAccessToken(deps: TwitchTokenDeps): Promise<string> {
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetchImpl ?? fetch

  const sealed = await readPlatformToken(deps.pool, 'twitch')
  const refreshToken =
    sealed === null ? await seed(deps.pool, deps.envToken, deps.key) : unsealOrThrow(sealed, deps.key)

  const cacheKey = `${deps.clientId}:${refreshToken}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined && now() < cached.expiresAt) return cached.accessToken

  const refreshed = await refreshGrant({
    fetchImpl,
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    refreshToken,
    now,
  })

  // Twitch rotates refresh tokens on some grants and not others. Writing only when one
  // came back keeps a refresh that returned the same token from rewrapping the row, while
  // a rotation is persisted before the access token is handed out.
  if (refreshed.refreshToken !== undefined && refreshed.refreshToken !== refreshToken) {
    await writePlatformToken(deps.pool, 'twitch', sealToken(refreshed.refreshToken, deps.key))
    // The entry keyed by the spent token belongs to a grant Twitch just replaced, so it can
    // never be read again. Dropping it keeps a process that runs for months from growing the
    // map by one dead entry per rotation.
    cache.delete(cacheKey)
  }

  cache.set(`${deps.clientId}:${refreshed.refreshToken ?? refreshToken}`, {
    accessToken: refreshed.accessToken,
    expiresAt: refreshed.expiresAt,
  })
  return refreshed.accessToken
}
