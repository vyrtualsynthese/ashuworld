import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { readPlatformToken, writePlatformToken } from '@ashuworld/ledger'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import { openToken, sealToken, type DiscoveredPerson } from '@ashuworld/providers'
import type { WorkerEnv } from '../src/config.js'
import { createTwitchConnector } from '../src/connectors/twitch.js'
import { getTwitchAccessToken, type TwitchTokenDeps } from '../src/connectors/twitchToken.js'

/** Two real 32-byte keys: the second one is what a mismatched PLATFORM_TOKEN_KEY looks like. */
const KEY = randomBytes(32).toString('base64')
const OTHER_KEY = randomBytes(32).toString('base64')

let db: TestDb
let pool: Pool

beforeAll(async () => {
  db = await createTestDb()
  pool = db.pool
})

beforeEach(async () => {
  await db.reset()
})

afterAll(async () => {
  await pool.end()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface RecordedCall {
  url: URL
  body: URLSearchParams
  headers: Headers
}

/**
 * A `fetch` that answers from `handler` and records what the code under test sent.
 *
 * The token endpoint, the user lookup and both follower pages all go through this one
 * function, so a test can assert the order and the exact query strings without a socket.
 */
function recordingFetch(handler: (url: URL) => Response): {
  fetchImpl: typeof fetch
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams()
    calls.push({ url, body, headers: new Headers(init?.headers) })
    return handler(url)
  }
  return { fetchImpl, calls }
}

/** The deps `getTwitchAccessToken` needs, with one test's own fetch and clock on top. */
function tokenDeps(fetchImpl: typeof fetch, overrides: Partial<TwitchTokenDeps> = {}): TwitchTokenDeps {
  return {
    pool,
    clientId: 'test-client',
    clientSecret: 'client-secret',
    envToken: 'rt-env',
    key: KEY,
    fetchImpl,
    ...overrides,
  }
}

/**
 * A sleep that records instead of waiting, so a test asserts the delay it was asked for.
 *
 * The connector is told to use this wherever it would really pause, which keeps a test of a
 * two-second rate-limit wait instant.
 */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms)
    },
  }
}

/** A complete Twitch configuration, as `loadWorkerEnv` would produce it for the connector. */
function twitchEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    DATABASE_URL: 'postgres://unused',
    PLATFORM_CONNECTORS: ['twitch'],
    ALLOW_STUB_CONNECTORS: false,
    STUB_PEOPLE: 5,
    SYNC_INTERVAL_SECONDS: 900,
    TWITCH_CLIENT_ID: 'client-id',
    TWITCH_CLIENT_SECRET: 'client-secret',
    TWITCH_CHANNEL_LOGIN: 'channel-login',
    TWITCH_CHANNEL_REFRESH_TOKEN: 'rt-env',
    PLATFORM_TOKEN_KEY: KEY,
    ...overrides,
  }
}

function follower(id: string): Record<string, string> {
  return { user_id: id, user_login: `login-${id}`, user_name: `Follower ${id}` }
}

async function collect(connector: { discover(): AsyncIterable<DiscoveredPerson> }): Promise<DiscoveredPerson[]> {
  const people: DiscoveredPerson[] = []
  for await (const person of connector.discover()) people.push(person)
  return people
}

/** The error a failing async iteration throws, so a test can assert on it instead of on a rejected promise. */
async function failureOf(connector: {
  discover(): AsyncIterable<DiscoveredPerson>
}): Promise<{ error: unknown; people: DiscoveredPerson[] }> {
  const people: DiscoveredPerson[] = []
  try {
    for await (const person of connector.discover()) people.push(person)
  } catch (error) {
    return { error, people }
  }
  return { error: undefined, people }
}

describe('getTwitchAccessToken', () => {
  it('seeds the token table from the environment on first use', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json({ access_token: 'at', expires_in: 3600 }))

    const token = await getTwitchAccessToken(tokenDeps(fetchImpl, { clientId: 'seed-client' }))

    expect(token).toBe('at')
    // One refresh, carrying the environment token and the app credentials in the body.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url.href).toBe('https://id.twitch.tv/oauth2/token')
    expect(calls[0]?.body.get('grant_type')).toBe('refresh_token')
    expect(calls[0]?.body.get('refresh_token')).toBe('rt-env')
    expect(calls[0]?.body.get('client_id')).toBe('seed-client')
    expect(calls[0]?.body.get('client_secret')).toBe('client-secret')

    // What landed in the table is the sealed form, never the token itself.
    const sealed = await readPlatformToken(pool, 'twitch')
    expect(sealed).not.toBeNull()
    expect(sealed).not.toBe('rt-env')
    expect(sealed).not.toContain('rt-env')
    expect(openToken(sealed ?? '', KEY)).toBe('rt-env')
  })

  it('persists a rotated refresh token and uses it next time', async () => {
    let refreshes = 0
    const { fetchImpl, calls } = recordingFetch(() => {
      refreshes += 1
      // expires_in 60 means the next call is already past the cache window, so this also
      // proves the stored row, not the environment, is what the second refresh posts.
      return json({ access_token: `at-${refreshes}`, refresh_token: 'rt-2', expires_in: 60 })
    })
    const clock = { now: 0 }
    const deps = tokenDeps(fetchImpl, { clientId: 'rotate-client', now: () => clock.now })

    expect(await getTwitchAccessToken(deps)).toBe('at-1')
    const stored = await readPlatformToken(pool, 'twitch')
    expect(openToken(stored ?? '', KEY)).toBe('rt-2')

    clock.now = 3_600_000
    expect(await getTwitchAccessToken(deps)).toBe('at-2')
    expect(calls.map((call) => call.body.get('refresh_token'))).toEqual(['rt-env', 'rt-2'])
  })

  it('reuses the cached access token until it is within a minute of expiry', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json({ access_token: 'at', expires_in: 3600 }))
    const clock = { now: 0 }
    const deps = tokenDeps(fetchImpl, { clientId: 'cache-client', now: () => clock.now })

    expect(await getTwitchAccessToken(deps)).toBe('at')
    // Well inside the hour: answered from memory, so Twitch is not called again.
    clock.now = 3_000_000
    expect(await getTwitchAccessToken(deps)).toBe('at')
    expect(calls).toHaveLength(1)

    // Past expires_at - 60s: the entry is too close to expiry to trust.
    clock.now = 3_540_001
    expect(await getTwitchAccessToken(deps)).toBe('at')
    expect(calls).toHaveLength(2)
  })

  it('fails loudly when the stored token cannot be unsealed', async () => {
    await writePlatformToken(pool, 'twitch', sealToken('rt-other', OTHER_KEY))
    const { fetchImpl, calls } = recordingFetch(() => json({ access_token: 'at', expires_in: 3600 }))

    await expect(
      getTwitchAccessToken(tokenDeps(fetchImpl, { clientId: 'wrong-key-client' })),
    ).rejects.toThrow(/PLATFORM_TOKEN_KEY/)
    // The environment token may be the stale one, so it must not silently replace the row.
    expect(calls).toHaveLength(0)
    expect(openToken((await readPlatformToken(pool, 'twitch')) ?? '', OTHER_KEY)).toBe('rt-other')
  })

  it('refuses to invent a grant when neither the row nor the environment has one', async () => {
    const { fetchImpl, calls } = recordingFetch(() => json({ access_token: 'at', expires_in: 3600 }))
    const deps = tokenDeps(fetchImpl, { clientId: 'no-grant-client' })
    delete deps.envToken

    await expect(getTwitchAccessToken(deps)).rejects.toThrow(/TWITCH_CHANNEL_REFRESH_TOKEN/)
    // Nothing to refresh: the failure happens before any request leaves the process.
    expect(calls).toHaveLength(0)
  })

  it('names the status when Twitch refuses the refresh', async () => {
    const { fetchImpl } = recordingFetch(() => new Response('{"message":"Invalid refresh token"}', { status: 400 }))

    await expect(
      getTwitchAccessToken(tokenDeps(fetchImpl, { clientId: 'refresh-fail-client' })),
    ).rejects.toThrow(/400/)
  })

  it('waits out a rate-limited refresh through the same helper as the pages', async () => {
    let refreshes = 0
    const { fetchImpl, calls } = recordingFetch(() => {
      refreshes += 1
      if (refreshes === 1) {
        return new Response('{"message":"too many requests"}', {
          status: 429,
          headers: { 'retry-after': '1' },
        })
      }
      return json({ access_token: 'at', expires_in: 3600 })
    })
    const { sleep, delays } = recordingSleep()

    const token = await getTwitchAccessToken(
      tokenDeps(fetchImpl, { clientId: 'rate-limited-refresh-client', sleep }),
    )

    expect(token).toBe('at')
    // One second, as the header said, then the same refresh sent again with the same grant.
    expect(delays).toEqual([1000])
    expect(calls.map((call) => call.body.get('refresh_token'))).toEqual(['rt-env', 'rt-env'])
  })

  it('gives up on a refresh that keeps being rate limited', async () => {
    const { fetchImpl, calls } = recordingFetch(() => new Response('slow down', { status: 429 }))
    const { sleep, delays } = recordingSleep()

    await expect(
      getTwitchAccessToken(tokenDeps(fetchImpl, { clientId: 'always-limited-client', sleep })),
    ).rejects.toThrow(/429/)

    // Four attempts and three waits: one more of either is a refresh loop, not a retry.
    expect(calls).toHaveLength(4)
    expect(delays).toEqual([1000, 1000, 1000])
  })
})

describe('createTwitchConnector', () => {
  /**
   * One handler for every endpoint the connector uses: the token refresh, the broadcaster
   * lookup and the follower pages, which answer from `pages`.
   */
  function helixFetch(
    pages: Record<string, Response>,
    users: Response = json({ data: [{ id: '42', login: 'channel-login' }] }),
  ) {
    return recordingFetch((url) => {
      if (url.pathname === '/oauth2/token') return json({ access_token: 'at', expires_in: 3600 })
      if (url.pathname === '/helix/users') return users
      if (url.pathname === '/helix/channels/followers') {
        return pages[url.searchParams.get('after') ?? 'first'] ?? json({ data: [], pagination: {} })
      }
      return new Response('unexpected', { status: 404 })
    })
  }

  it('pages the follower list into people', async () => {
    const { fetchImpl, calls } = helixFetch({
      first: json({ data: [follower('1'), follower('2')], pagination: { cursor: 'page-2' } }),
      'page-2': json({ data: [follower('3')], pagination: {} }),
    })
    const connector = createTwitchConnector({ pool, env: twitchEnv(), fetchImpl })

    const people = await collect(connector)

    expect(people).toEqual([
      {
        provider: 'twitch',
        externalId: '1',
        displayHandle: 'login-1',
        displayName: 'Follower 1',
        actions: ['twitch.follow'],
      },
      {
        provider: 'twitch',
        externalId: '2',
        displayHandle: 'login-2',
        displayName: 'Follower 2',
        actions: ['twitch.follow'],
      },
      {
        provider: 'twitch',
        externalId: '3',
        displayHandle: 'login-3',
        displayName: 'Follower 3',
        actions: ['twitch.follow'],
      },
    ])

    // The broadcaster is resolved once, by login, and every page carries its id and the
    // page size. The second page is asked for with the cursor the first page returned.
    const users = calls.filter((call) => call.url.pathname === '/helix/users')
    expect(users).toHaveLength(1)
    expect(users[0]?.url.searchParams.get('login')).toBe('channel-login')
    const pages = calls.filter((call) => call.url.pathname === '/helix/channels/followers')
    expect(pages.map((call) => call.url.searchParams.get('after'))).toEqual([null, 'page-2'])
    expect(pages.every((call) => call.url.searchParams.get('broadcaster_id') === '42')).toBe(true)
    expect(pages.every((call) => call.url.searchParams.get('first') === '100')).toBe(true)
    expect(pages[0]?.headers.get('authorization')).toBe('Bearer at')
    expect(pages[0]?.headers.get('client-id')).toBe('client-id')
  })

  it('refreshes the access token once across discovery runs', async () => {
    // Fresh `Response` objects per call: a body can only be read once, and this test runs
    // both rounds through the same handler.
    const { fetchImpl, calls } = recordingFetch((url) => {
      if (url.pathname === '/oauth2/token') return json({ access_token: 'at', expires_in: 3600 })
      if (url.pathname === '/helix/users') return json({ data: [{ id: '42', login: 'channel-login' }] })
      return json({ data: [], pagination: {} })
    })
    const connector = createTwitchConnector({
      pool,
      // A client id of its own keeps this case off the module cache entries the tests
      // above created, so the first run here is a real refresh.
      env: twitchEnv({ TWITCH_CLIENT_ID: 'cached-connector-client' }),
      fetchImpl,
    })

    await collect(connector)
    await collect(connector)

    // The second run reads the same sealed row and is answered from memory: the access
    // token is fetched once for both rounds, not once per round.
    const refreshes = calls.filter((call) => call.url.pathname === '/oauth2/token')
    expect(refreshes).toHaveLength(1)
  })

  /** A Twitch that answers the first follower page with `first`, then serves `then`. */
  function limitedFollowerFetch(first: Response, then: () => Response) {
    let pages = 0
    return recordingFetch((url) => {
      if (url.pathname === '/oauth2/token') return json({ access_token: 'at', expires_in: 3600 })
      if (url.pathname === '/helix/users') return json({ data: [{ id: '42', login: 'channel-login' }] })
      pages += 1
      return pages === 1 ? first : then()
    })
  }

  it('waits what Retry-After asks and asks for the same page again', async () => {
    const { fetchImpl, calls } = limitedFollowerFetch(
      new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }),
      () => json({ data: [follower('1')], pagination: {} }),
    )
    const { sleep, delays } = recordingSleep()
    const connector = createTwitchConnector({ pool, env: twitchEnv(), fetchImpl, sleep })

    const people = await collect(connector)

    // The page arrives, and the two seconds the header asked for is what was waited.
    expect(people.map((person) => person.externalId)).toEqual(['1'])
    expect(delays).toEqual([2000])

    // The retry is the same request, not a re-planned one: same query string, same headers.
    const pages = calls.filter((call) => call.url.pathname === '/helix/channels/followers')
    expect(pages).toHaveLength(2)
    expect(pages[1]?.url.href).toBe(pages[0]?.url.href)
  })

  it('waits the default when the rate limit names no delay', async () => {
    const { fetchImpl } = limitedFollowerFetch(new Response('rate limited', { status: 429 }), () =>
      json({ data: [], pagination: {} }),
    )
    const { sleep, delays } = recordingSleep()
    const connector = createTwitchConnector({ pool, env: twitchEnv(), fetchImpl, sleep })

    await collect(connector)

    expect(delays).toEqual([1000])
  })

  it('gives up on a page that keeps being rate limited', async () => {
    const { fetchImpl, calls } = limitedFollowerFetch(new Response('rate limited', { status: 429 }), () =>
      new Response('rate limited', { status: 429 }),
    )
    const { sleep, delays } = recordingSleep()
    const connector = createTwitchConnector({ pool, env: twitchEnv(), fetchImpl, sleep })

    const { error } = await failureOf(connector)

    // Four attempts and three waits, then the ordinary refusal naming the status: waiting
    // longer would hold the round open instead of letting the next tick try again.
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('429')
    expect(delays).toEqual([1000, 1000, 1000])
    expect(calls.filter((call) => call.url.pathname === '/helix/channels/followers')).toHaveLength(4)
  })

  it('reports a failed follower page without yielding partial garbage', async () => {
    const { fetchImpl } = helixFetch({
      first: json({ data: [follower('1'), follower('2')], pagination: { cursor: 'page-2' } }),
      'page-2': new Response('upstream is down', { status: 500 }),
    })
    const { sleep, delays } = recordingSleep()
    const connector = createTwitchConnector({ pool, env: twitchEnv(), fetchImpl, sleep })

    const { error, people } = await failureOf(connector)

    // The iteration throws, naming the status: the runner logs it against this connector
    // and retries next round. What the first page yielded is whole; nothing invented is
    // yielded for the page that failed.
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('500')
    expect(people.map((person) => person.externalId)).toEqual(['1', '2'])
    // A 500 is an outage, not a rate limit: no wait, no second request for that page.
    expect(delays).toEqual([])
  })

  it('throws when a follower row has no usable identity', async () => {
    const { fetchImpl } = helixFetch({
      first: json({ data: [{ user_id: '9', user_name: 'Nameless' }], pagination: {} }),
    })
    const connector = createTwitchConnector({ pool, env: twitchEnv(), fetchImpl })

    const { error } = await failureOf(connector)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('user_login')
  })

  it('throws naming the login when Twitch knows no such broadcaster', async () => {
    const { fetchImpl } = helixFetch({}, json({ data: [] }))
    const connector = createTwitchConnector({ pool, env: twitchEnv(), fetchImpl })

    await expect(collect(connector)).rejects.toThrow(/channel-login/)
  })

  it('refuses to build without the channel login', () => {
    const env = twitchEnv()
    delete env.TWITCH_CHANNEL_LOGIN

    expect(() => createTwitchConnector({ pool, env })).toThrow(/TWITCH_CHANNEL_LOGIN/)
  })
})
