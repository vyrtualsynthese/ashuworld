import { Writable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GameConfig } from '@ashuworld/gameconfig'
import {
  awardOnce,
  createFan,
  detachIdentity,
  ensureIdentity,
  linkIdentity,
  withTransaction,
  type Queryable,
} from '@ashuworld/ledger'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import type { Env } from '../src/config.js'
import { buildServer } from '../src/server.js'
import { consumeHandshake, startHandshake } from '../src/auth/handshake.js'
import {
  HandleExhaustedError,
  MAX_HANDLE_ATTEMPTS,
  baseHandle,
  createFanWithUniqueHandle,
  suffixedHandle,
} from '../src/auth/handles.js'
import { createDevProvider } from '../src/auth/providers.js'
import type {
  ExchangeInput,
  OAuthProvider,
  ProviderRegistry,
} from '../src/auth/providers.js'
import { createSession } from '../src/auth/session.js'
import { OAUTH_STATE_COOKIE_NAME } from '../src/routes/auth.js'

const cfg: GameConfig = {
  version: 'test',
  actions: {
    'twitch.follow': { amount: 50, provider: 'twitch' },
  },
  levels: [
    { level: 0, minXp: 0 },
    { level: 1, minXp: 100 },
    { level: 2, minXp: 300 },
  ],
}

const COOKIE = 'ashuworld_session'
const REDIRECT_URI = 'http://localhost:3000/auth/dev/callback'

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
    SESSION_COOKIE_NAME: COOKIE,
    COOKIE_SECURE: false,
    ALLOW_DEV_LOGIN: true,
    TRUST_PROXY: false,
    PUBLIC_BASE_URL: 'http://localhost:3000',
    PORT: 3000,
    ...overrides,
  }
}

let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
})

afterAll(async () => {
  await db.pool.end()
})

beforeEach(async () => {
  await db.reset()
})

async function withApp(
  run: (app: FastifyInstance) => Promise<void>,
  env: Partial<Env> = {},
  providers?: ProviderRegistry,
): Promise<void> {
  const app = buildServer({
    pool: db.pool,
    cfg,
    env: testEnv(env),
    ...(providers === undefined ? {} : { providers }),
  })
  app.log.level = 'silent'
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

interface Injected {
  statusCode: number
  headers: Record<string, unknown>
  json(): unknown
  body: string
}

function cookiesOf(res: Injected): string[] {
  const header = res.headers['set-cookie']
  if (header === undefined) return []
  return Array.isArray(header) ? header.map(String) : [String(header)]
}

function cookieNamed(res: Injected, name: string): string | undefined {
  return cookiesOf(res).find((cookie) => cookie.startsWith(`${name}=`))
}

function cookieValue(cookie: string): string {
  const pair = cookie.split(';')[0] ?? ''
  return pair.slice(pair.indexOf('=') + 1)
}

/** The session cookie the response set, if any. Its absence is what "no login" means. */
function sessionSetCookie(res: Injected): string | undefined {
  return cookieNamed(res, COOKIE)
}

function sessionCookieOf(res: Injected): string {
  const cookie = sessionSetCookie(res)
  return cookie === undefined ? '' : cookieValue(cookie)
}

/** The browser-binding cookie's value, or undefined when the response did not set one. */
function bindingValueOf(res: Injected): string | undefined {
  const cookie = cookieNamed(res, OAUTH_STATE_COOKIE_NAME)
  return cookie === undefined ? undefined : cookieValue(cookie)
}

function locationOf(res: Injected): string {
  const location = res.headers['location']
  if (typeof location !== 'string') throw new Error('the response has no Location header')
  return location
}

function stateOf(res: Injected): string {
  const state = new URL(locationOf(res)).searchParams.get('state')
  if (state === null) throw new Error('the redirect carries no state')
  return state
}

function cookieHeader(sessionId: string): { cookie: string } {
  return { cookie: `${COOKIE}=${sessionId}` }
}

async function startDev(
  app: FastifyInstance,
  options: { purpose?: string; handle?: string; cookie?: string } = {},
): Promise<Injected> {
  const query = new URLSearchParams({ purpose: options.purpose ?? 'login' })
  if (options.handle !== undefined) query.set('handle', options.handle)
  return app.inject({
    method: 'GET',
    url: `/auth/dev/start?${query.toString()}`,
    ...(options.cookie === undefined ? {} : { headers: cookieHeader(options.cookie) }),
  })
}

async function newState(
  app: FastifyInstance,
  options: { handle?: string; purpose?: string; cookie?: string } = {},
): Promise<string> {
  const res = await startDev(app, options)
  if (res.statusCode !== 302) {
    throw new Error(`start answered ${res.statusCode}: ${res.body}`)
  }
  return stateOf(res)
}

async function callback(
  app: FastifyInstance,
  options: {
    state: string
    code?: string
    provider?: string
    cookie?: string
    /** Defaults to the state, as a browser that started the handshake would hold. */
    stateCookie?: string | null
    host?: string
  },
): Promise<Injected> {
  const query = new URLSearchParams({ state: options.state })
  if (options.code !== undefined) query.set('code', options.code)
  const provider = options.provider ?? 'dev'

  const jars: string[] = []
  if (options.cookie !== undefined) jars.push(`${COOKIE}=${options.cookie}`)
  const binding = options.stateCookie === undefined ? options.state : options.stateCookie
  if (binding !== null) jars.push(`${OAUTH_STATE_COOKIE_NAME}=${binding}`)

  const headers: Record<string, string> = {}
  if (jars.length > 0) headers['cookie'] = jars.join('; ')
  if (options.host !== undefined) headers['host'] = options.host

  return app.inject({
    method: 'GET',
    url: `/auth/${provider}/callback?${query.toString()}`,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  })
}

/** Signs in through the dev door and returns the session cookie that came back. */
async function login(
  app: FastifyInstance,
  code = 'ashu',
): Promise<{ cookie: string; res: Injected }> {
  const state = await newState(app, { handle: code })
  const res = await callback(app, { state, code })
  return { cookie: sessionCookieOf(res), res }
}

async function count(table: 'fans' | 'provider_identities' | 'sessions' | 'oauth_handshakes'): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(`select count(*)::text as n from ${table}`)
  return Number(rows[0]?.n ?? '0')
}

async function seedFan(handle: string, displayName = handle): Promise<string> {
  const { id } = await withTransaction(db.pool, (tx) => createFan(tx, { handle, displayName }))
  return id
}

async function seedSession(fanId: string): Promise<string> {
  return withTransaction(db.pool, (tx) => createSession(tx, fanId))
}

async function fanIdByHandle(handle: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>('select id from fans where handle = $1', [handle])
  const row = rows[0]
  if (row === undefined) throw new Error(`no fans row for handle ${handle}`)
  return row.id
}

interface IdentityRow {
  id: string
  fan_id: string | null
  linked_at: Date | null
  first_linked_at: Date | null
}

async function identityRow(externalId: string): Promise<IdentityRow> {
  const { rows } = await db.pool.query<IdentityRow>(
    `select id, fan_id, linked_at, first_linked_at
       from provider_identities
      where provider = 'dev' and external_id = $1`,
    [externalId],
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`no dev identity ${externalId}`)
  return row
}

/** Attaches a second (twitch) identity, which detach needs to be allowed at all. */
async function seedTwitchIdentity(fanId: string): Promise<string> {
  return withTransaction(db.pool, async (tx) => {
    const identity = await ensureIdentity(tx, {
      provider: 'twitch',
      externalId: 'tw-1',
      displayHandle: 'ashu_tv',
      displayName: 'Ashu TV',
    })
    const linked = await linkIdentity(tx, { fanId, identityId: identity.id, cfg })
    if (!linked.ok) throw new Error(`seeding failed: ${linked.reason}`)
    return identity.id
  })
}

describe('GET /auth/:provider/start', () => {
  it('rejects an unknown provider', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/auth/myspace/start?purpose=login' })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        error: { code: 'unknown_provider', message: 'that sign-in provider is not configured' },
      })
      expect(cookiesOf(res)).toEqual([])
    })
  })

  it('registers the dev provider only when ALLOW_DEV_LOGIN is true', async () => {
    await withApp(
      async (app) => {
        const start = await app.inject({ method: 'GET', url: '/auth/dev/start?purpose=login' })
        expect(start.statusCode).toBe(400)
        expect(start.json()).toEqual({
          error: { code: 'unknown_provider', message: 'that sign-in provider is not configured' },
        })

        const cb = await app.inject({
          method: 'GET',
          url: '/auth/dev/callback?code=ashu&state=x',
        })
        expect(cb.statusCode).toBe(400)
        expect(cb.json()).toMatchObject({ error: { code: 'unknown_provider' } })
      },
      { ALLOW_DEV_LOGIN: false },
    )
  })

  it('redirects to the provider without issuing a session', async () => {
    await withApp(async (app) => {
      const res = await startDev(app)

      expect(res.statusCode).toBe(302)
      const location = new URL(locationOf(res))
      expect(location.origin).toBe('http://localhost:3000')
      expect(location.pathname).toBe('/auth/dev/callback')
      expect(location.searchParams.get('code')).toBe('ashu')
      expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      // R18: the only place a session cookie may be set is a callback that verified an
      // identity. The start sets only the browser-binding state cookie.
      expect(sessionSetCookie(res)).toBeUndefined()
      const binding = cookieNamed(res, OAUTH_STATE_COOKIE_NAME)
      expect(binding).toBeDefined()
      expect(binding).toContain('HttpOnly')
      expect(binding).toContain('SameSite=Lax')
      expect(binding).toContain('Path=/auth')
      expect(binding).toContain('Max-Age=600')
      expect(binding).not.toContain('Secure')
      expect(bindingValueOf(res)).toBe(location.searchParams.get('state'))
      expect(await count('oauth_handshakes')).toBe(1)
      expect(await count('sessions')).toBe(0)
    })
  })

  it('marks the binding cookie Secure when COOKIE_SECURE is true', async () => {
    await withApp(
      async (app) => {
        const res = await startDev(app)
        expect(cookieNamed(res, OAUTH_STATE_COOKIE_NAME)).toContain('Secure')
      },
      { COOKIE_SECURE: true },
    )
  })

  it('builds the provider redirect from PUBLIC_BASE_URL, not the request Host', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/dev/start?purpose=login',
        headers: { host: 'evil.example' },
      })

      expect(res.statusCode).toBe(302)
      const location = new URL(locationOf(res))
      expect(location.origin).toBe('http://localhost:3000')
      expect(location.href).not.toContain('evil.example')
    })
  })

  it('builds the callback exchange redirect from PUBLIC_BASE_URL, not the request Host', async () => {
    // The start redirect is visible in its Location header; the exchange's redirect URI
    // is not, and it is the one the provider sends the browser back to. A Host-shaped
    // value here would let a caller aim that bounce at a host of their choosing, so the
    // registry is wrapped to record exactly what the callback hands the provider.
    const dev = createDevProvider()
    const exchanges: ExchangeInput[] = []
    const observing: OAuthProvider = {
      name: 'dev',
      authorizeUrl: (input) => dev.authorizeUrl(input),
      exchange: async (input) => {
        exchanges.push(input)
        return dev.exchange(input)
      },
    }
    const registry: ProviderRegistry = {
      get: (name) => (name === 'dev' ? observing : undefined),
    }

    await withApp(
      async (app) => {
        const state = await newState(app)
        const res = await callback(app, { state, code: 'ashu', host: 'evil.example' })

        expect(res.statusCode).toBe(302)
        expect(exchanges).toHaveLength(1)
        expect(exchanges[0]?.redirectUri).toBe(REDIRECT_URI)
        expect(exchanges[0]?.redirectUri).not.toContain('evil.example')
      },
      {},
      registry,
    )
  })

  it('carries the requested handle into the dev provider redirect', async () => {
    await withApp(async (app) => {
      const res = await startDev(app, { handle: 'bob' })

      expect(res.statusCode).toBe(302)
      expect(new URL(locationOf(res)).searchParams.get('code')).toBe('bob')
    })
  })

  it('generates a different 32-byte state for every handshake', async () => {
    await withApp(async (app) => {
      const first = stateOf(await startDev(app))
      const second = stateOf(await startDev(app))

      expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(first).not.toBe(second)
    })
  })

  it('rejects a purpose other than login or link', async () => {
    await withApp(async (app) => {
      const res = await startDev(app, { purpose: 'admin' })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        error: { code: 'invalid_purpose', message: 'purpose must be "login" or "link"' },
      })
      expect(await count('oauth_handshakes')).toBe(0)
    })
  })

  it('refuses a duplicated purpose instead of defaulting to login', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/dev/start?purpose=link&purpose=login',
      })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        error: { code: 'invalid_purpose', message: 'purpose must be "login" or "link"' },
      })
      expect(await count('oauth_handshakes')).toBe(0)
      expect(await count('sessions')).toBe(0)
    })
  })

  it('refuses a link handshake without a signed-in fan', async () => {
    await withApp(async (app) => {
      const res = await startDev(app, { purpose: 'link' })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({
        error: { code: 'unauthenticated', message: 'sign in to continue' },
      })
      expect(await count('oauth_handshakes')).toBe(0)
    })
  })
})

describe('handshake storage', () => {
  it('consumes a state exactly once', async () => {
    await withApp(async (app) => {
      const state = await newState(app)

      const first = await withTransaction(db.pool, (tx) =>
        consumeHandshake(tx, { state, provider: 'dev' }),
      )
      const second = await withTransaction(db.pool, (tx) =>
        consumeHandshake(tx, { state, provider: 'dev' }),
      )

      expect(first).toEqual({ provider: 'dev', purpose: 'login', fanId: null })
      expect(second).toBeNull()
      expect(await count('oauth_handshakes')).toBe(0)
    })
  })

  it('refuses to redeem a state at a different provider', async () => {
    const dev = createDevProvider()

    await withApp(async () => {
      const { state } = await withTransaction(db.pool, (tx) =>
        startHandshake(tx, { provider: dev, purpose: 'login', fanId: null, redirectUri: REDIRECT_URI }),
      )

      const crossed = await withTransaction(db.pool, (tx) =>
        consumeHandshake(tx, { state, provider: 'twitch' }),
      )
      expect(crossed).toBeNull()
      // The wrong-provider attempt must not burn the state for its rightful owner.
      const right = await withTransaction(db.pool, (tx) =>
        consumeHandshake(tx, { state, provider: 'dev' }),
      )
      expect(right).toEqual({ provider: 'dev', purpose: 'login', fanId: null })
    })
  })

  it('expires a handshake after ten minutes', async () => {
    const dev = createDevProvider()

    await withApp(async () => {
      const { state } = await withTransaction(db.pool, (tx) =>
        startHandshake(tx, { provider: dev, purpose: 'login', fanId: null, redirectUri: REDIRECT_URI }),
      )
      const { rows } = await db.pool.query<{ ttl: number }>(
        `select extract(epoch from expires_at - created_at)::int as ttl
           from oauth_handshakes where state = $1`,
        [state],
      )
      expect(rows[0]?.ttl).toBe(600)

      await db.pool.query(
        `update oauth_handshakes set expires_at = now() - interval '1 second' where state = $1`,
        [state],
      )
      const consumed = await withTransaction(db.pool, (tx) =>
        consumeHandshake(tx, { state, provider: 'dev' }),
      )
      expect(consumed).toBeNull()
      expect(await count('oauth_handshakes')).toBe(0)
    })
  })

  it('refuses a malformed state without querying the database', async () => {
    const neverQueried: Queryable = {
      query: async () => {
        throw new Error('consumeHandshake queried the database for a malformed state')
      },
    }

    await expect(
      consumeHandshake(neverQueried, { state: 'short', provider: 'dev' }),
    ).resolves.toBeNull()
    await expect(
      consumeHandshake(neverQueried, { state: 'x'.repeat(44), provider: 'dev' }),
    ).resolves.toBeNull()
    await expect(
      consumeHandshake(neverQueried, { state: 'abc$def', provider: 'dev' }),
    ).resolves.toBeNull()
  })

  it('refuses to start a link handshake without a fan to attach to', async () => {
    const dev = createDevProvider()

    await expect(
      withTransaction(db.pool, (tx) =>
        startHandshake(tx, { provider: dev, purpose: 'link', fanId: null, redirectUri: REDIRECT_URI }),
      ),
    ).rejects.toThrow(/needs a signed-in fan/)
    expect(await count('oauth_handshakes')).toBe(0)
  })
})

describe('GET /auth/:provider/callback: login', () => {
  it('logs in through the dev provider and sets a session', async () => {
    await withApp(async (app) => {
      const { cookie, res } = await login(app)

      expect(res.statusCode).toBe(302)
      expect(locationOf(res)).toBe('/account')
      const setCookie = sessionSetCookie(res)
      expect(setCookie).toContain(`${COOKIE}=`)
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Lax')
      expect(setCookie).toContain('Path=/')
      expect(setCookie).not.toContain('Secure')
      // The binding cookie is cleared on the terminal callback path.
      expect(cookieNamed(res, OAUTH_STATE_COOKIE_NAME)).toContain('Max-Age=0')
      // The redirect body is empty; the only place the value appears is the cookie.
      expect(res.body).toBe('')
      expect(res.body).not.toContain(cookie)

      const me = await app.inject({ method: 'GET', url: '/api/me', headers: cookieHeader(cookie) })
      expect(me.statusCode).toBe(200)
      expect(me.json()).toMatchObject({ handle: 'ashu', displayName: 'ashu' })

      expect(await count('fans')).toBe(1)
      expect(await count('provider_identities')).toBe(1)
      expect(await count('sessions')).toBe(1)
    })
  })

  it('creates one fan for a never-linked identity and reuses it next time', async () => {
    await withApp(async (app) => {
      const first = await login(app, 'ashu')
      const second = await login(app, 'ashu')

      expect(first.res.statusCode).toBe(302)
      expect(second.res.statusCode).toBe(302)
      expect(await count('fans')).toBe(1)
      expect(await count('provider_identities')).toBe(1)

      const firstMe = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(first.cookie),
      })
      const secondMe = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(second.cookie),
      })
      const firstId = (firstMe.json() as { id: string }).id
      const secondId = (secondMe.json() as { id: string }).id
      expect(firstId).toBe(secondId)

      // Session multiplicity: signing in on a second device must not sign the first out.
      expect(firstMe.statusCode).toBe(200)
      expect(secondMe.statusCode).toBe(200)
      expect(await count('sessions')).toBe(2)
    })
  })

  it('deduplicates a handle that is already taken', async () => {
    await withApp(async (app) => {
      await seedFan('ashu')
      await seedFan('ashu_2')

      const { res } = await login(app, 'Ashu')

      expect(res.statusCode).toBe(302)
      const { rows } = await db.pool.query<{ handle: string }>('select handle from fans order by handle')
      expect(rows.map((row) => row.handle)).toEqual(['ashu', 'ashu_2', 'ashu_3'])
    })
  })

  it('resolves two simultaneous first logins to one fan', async () => {
    await withApp(async (app) => {
      const [first, second] = await Promise.all([
        newState(app, { handle: 'ashu' }),
        newState(app, { handle: 'ashu' }),
      ])
      const [a, b] = await Promise.all([
        callback(app, { state: first, code: 'ashu' }),
        callback(app, { state: second, code: 'ashu' }),
      ])

      expect(a.statusCode).toBe(302)
      expect(b.statusCode).toBe(302)
      expect(await count('fans')).toBe(1)
      expect(await count('provider_identities')).toBe(1)
    })
  })

  it('succeeds when the callback presents the binding cookie the start set', async () => {
    await withApp(async (app) => {
      const start = await startDev(app)
      const state = stateOf(start)
      const binding = bindingValueOf(start)
      if (binding === undefined) throw new Error('the start set no binding cookie')

      const res = await callback(app, { state, code: 'ashu', stateCookie: binding })

      expect(res.statusCode).toBe(302)
      expect(locationOf(res)).toBe('/account')
      expect(sessionSetCookie(res)).toBeDefined()
      expect(await count('oauth_handshakes')).toBe(0)
    })
  })

  it('refuses a callback with a valid state but no binding cookie, unconsumed', async () => {
    await withApp(async (app) => {
      const state = await newState(app)

      // A 302 URL copied into another browser arrives without that browser's cookie.
      const res = await callback(app, { state, code: 'ashu', stateCookie: null })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        error: { code: 'handshake_invalid', message: 'this sign-in link has expired or was already used' },
      })
      expect(sessionSetCookie(res)).toBeUndefined()
      // Not consumed: the browser that really started the handshake can still finish.
      expect(await count('oauth_handshakes')).toBe(1)
      expect(await count('sessions')).toBe(0)

      const retry = await callback(app, { state, code: 'ashu' })
      expect(retry.statusCode).toBe(302)
    })
  })

  it('refuses a callback whose binding cookie names another state, unconsumed', async () => {
    await withApp(async (app) => {
      const state = await newState(app)

      const res = await callback(app, {
        state,
        code: 'ashu',
        stateCookie: 'x'.repeat(43),
      })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: { code: 'handshake_invalid' } })
      expect(await count('oauth_handshakes')).toBe(1)

      const retry = await callback(app, { state, code: 'ashu' })
      expect(retry.statusCode).toBe(302)
    })
  })

  it('refuses to reuse a handshake state', async () => {
    await withApp(async (app) => {
      const state = await newState(app)
      const first = await callback(app, { state, code: 'ashu' })
      expect(first.statusCode).toBe(302)

      const second = await callback(app, { state, code: 'ashu' })
      expect(second.statusCode).toBe(400)
      expect(second.json()).toEqual({
        error: { code: 'handshake_invalid', message: 'this sign-in link has expired or was already used' },
      })
      expect(sessionSetCookie(second)).toBeUndefined()
      expect(cookieNamed(second, OAUTH_STATE_COOKIE_NAME)).toContain('Max-Age=0')
      expect(await count('sessions')).toBe(1)
    })
  })

  it('refuses an expired handshake at the callback', async () => {
    await withApp(async (app) => {
      const state = await newState(app)
      await db.pool.query(
        `update oauth_handshakes set expires_at = now() - interval '1 second' where state = $1`,
        [state],
      )

      const res = await callback(app, { state, code: 'ashu' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: { code: 'handshake_invalid' } })
      expect(sessionSetCookie(res)).toBeUndefined()
      expect(await count('fans')).toBe(0)
      expect(await count('sessions')).toBe(0)
    })
  })

  it('refuses a callback without the state or the code', async () => {
    await withApp(async (app) => {
      const noQuery = await app.inject({ method: 'GET', url: '/auth/dev/callback' })
      expect(noQuery.statusCode).toBe(400)
      expect(noQuery.json()).toMatchObject({ error: { code: 'invalid_request' } })

      const state = await newState(app)
      const noCode = await callback(app, { state })
      expect(noCode.statusCode).toBe(400)
      expect(noCode.json()).toMatchObject({ error: { code: 'invalid_request' } })
      expect(sessionSetCookie(noCode)).toBeUndefined()
    })
  })

  it('issues no session when the provider refuses the code', async () => {
    await withApp(async (app) => {
      const state = await newState(app)
      const res = await callback(app, { state, code: 'not a handle' })

      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ error: { code: 'provider_error' } })
      expect(sessionSetCookie(res)).toBeUndefined()
      expect(await count('fans')).toBe(0)
      expect(await count('sessions')).toBe(0)
    })
  })

  it('asks for confirmation instead of silently re-attaching a detached identity', async () => {
    await withApp(async (app) => {
      const first = await login(app, 'ashu')
      const fanId = await fanIdByHandle('ashu')
      const identityId = (await identityRow('dev:ashu')).id
      await seedTwitchIdentity(fanId)
      const detached = await withTransaction(db.pool, (tx) =>
        detachIdentity(tx, { fanId, identityId, cfg }),
      )
      expect(detached.ok).toBe(true)
      expect((await identityRow('dev:ashu')).fan_id).toBeNull()

      const again = await login(app, 'ashu')

      expect(again.res.statusCode).toBe(302)
      expect(locationOf(again.res)).toBe('/account?reattach=dev')
      expect(sessionSetCookie(again.res)).toBeUndefined()
      expect((await identityRow('dev:ashu')).fan_id).toBeNull()
      expect(await count('fans')).toBe(1)
      // Only the session from before the detach still exists.
      expect(await count('sessions')).toBe(1)
      expect(first.res.statusCode).toBe(302)
    })
  })
})

describe('GET /auth/:provider/callback: link', () => {
  it('attaches the identity the provider returns to the signed-in fan', async () => {
    await withApp(async (app) => {
      const fanId = await seedFan('ashu')
      const cookie = await seedSession(fanId)

      const state = await newState(app, { purpose: 'link', handle: 'bob', cookie })
      const res = await callback(app, { state, code: 'bob', cookie })

      expect(res.statusCode).toBe(302)
      expect(locationOf(res)).toBe('/account')
      // A link already has a proven fan; it must not mint a second session.
      expect(sessionSetCookie(res)).toBeUndefined()
      expect(cookieNamed(res, OAUTH_STATE_COOKIE_NAME)).toContain('Max-Age=0')
      expect(await count('fans')).toBe(1)
      const identity = await identityRow('dev:bob')
      expect(identity.fan_id).toBe(fanId)
      expect(identity.first_linked_at).not.toBeNull()
    })
  })

  it('refuses a link handshake started by another fan', async () => {
    await withApp(async (app) => {
      const owner = await seedFan('owner')
      const other = await seedFan('other')
      const ownerCookie = await seedSession(owner)
      const otherCookie = await seedSession(other)

      const state = await newState(app, { purpose: 'link', handle: 'bob', cookie: ownerCookie })
      const res = await callback(app, { state, code: 'bob', cookie: otherCookie })

      expect(res.statusCode).toBe(403)
      expect(res.json()).toEqual({
        error: { code: 'link_not_owner', message: 'this sign-in link was started by another fan' },
      })
      expect(sessionSetCookie(res)).toBeUndefined()
      // Nothing is created for the identity that was proved: the swap must not attach it
      // to the fan that did not start the handshake.
      expect(await count('provider_identities')).toBe(0)
    })
  })

  it('refuses a link callback with no signed-in fan', async () => {
    await withApp(async (app) => {
      const owner = await seedFan('owner')
      const ownerCookie = await seedSession(owner)
      const state = await newState(app, { purpose: 'link', handle: 'bob', cookie: ownerCookie })

      const res = await callback(app, { state, code: 'bob' })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({
        error: { code: 'unauthenticated', message: 'sign in to continue' },
      })
      expect(sessionSetCookie(res)).toBeUndefined()
      expect(await count('provider_identities')).toBe(0)
    })
  })

  it('treats a malformed link cookie as signed out without attaching anything', async () => {
    await withApp(async (app) => {
      const owner = await seedFan('owner')
      const ownerCookie = await seedSession(owner)
      const state = await newState(app, { purpose: 'link', handle: 'bob', cookie: ownerCookie })

      const res = await callback(app, { state, code: 'bob', cookie: 'not-a-session' })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({
        error: { code: 'unauthenticated', message: 'sign in to continue' },
      })
      expect(sessionSetCookie(res)).toBeUndefined()
      expect(await count('provider_identities')).toBe(0)
    })
  })

  it('refuses a second identity from a provider the fan already holds', async () => {
    await withApp(async (app) => {
      const { cookie } = await login(app, 'ashu')
      const state = await newState(app, { purpose: 'link', handle: 'bob', cookie })

      const res = await callback(app, { state, code: 'bob', cookie })

      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error: {
          code: 'same_provider',
          message: 'this account already has a dev identity; detach it before linking another',
        },
      })
    })
  })

  it('refuses an identity that is already attached to another fan', async () => {
    await withApp(async (app) => {
      // The dev door signs in ashu, who owns dev:bob.
      await login(app, 'bob')
      const other = await seedFan('other')
      const otherCookie = await seedSession(other)

      const state = await newState(app, { purpose: 'link', handle: 'bob', cookie: otherCookie })
      const res = await callback(app, { state, code: 'bob', cookie: otherCookie })

      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error: {
          code: 'identity_owned',
          message: 'that provider account is already attached to another fan',
        },
      })
      const firstFan = await fanIdByHandle('bob')
      expect((await identityRow('dev:bob')).fan_id).toBe(firstFan)
    })
  })

  it('re-attaches a detached identity and keeps its forfeit', async () => {
    await withApp(async (app) => {
      const first = await login(app, 'ashu')
      const fanId = await fanIdByHandle('ashu')
      const identity = await identityRow('dev:ashu')
      await seedTwitchIdentity(fanId)

      const devIdentityId = identity.id
      await withTransaction(db.pool, (tx) =>
        awardOnce(tx, {
          identityId: devIdentityId,
          provider: 'dev',
          actionKey: 'twitch.follow',
          amount: 50,
          idempotencyKey: 'dev-earn-1',
          cfg,
        }),
      )
      const detached = await withTransaction(db.pool, (tx) =>
        detachIdentity(tx, { fanId, identityId: devIdentityId, cfg }),
      )
      expect(detached).toEqual({ ok: true, forfeitedEntries: 1 })

      const state = await newState(app, { purpose: 'link', handle: 'ashu', cookie: first.cookie })
      const res = await callback(app, { state, code: 'ashu', cookie: first.cookie })

      expect(res.statusCode).toBe(302)
      const reattached = await identityRow('dev:ashu')
      expect(reattached.fan_id).toBe(fanId)
      expect(reattached.first_linked_at).not.toBeNull()
      const { rows } = await db.pool.query<{ forfeited: boolean; balance: number }>(
        `select forfeited_at is not null as forfeited,
                (select coalesce(sum(amount), 0)::int from xp_entries
                  where identity_id = $1 and kind = 'earn' and forfeited_at is null) as balance
           from xp_entries where identity_id = $1 and kind = 'earn'`,
        [devIdentityId],
      )
      expect(rows[0]?.forfeited).toBe(true)
      expect(rows[0]?.balance).toBe(0)
    })
  })
})

describe('log redaction', () => {
  it('keeps the callback code and state out of the request and error logs', async () => {
    const lines: string[] = []
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk))
        done()
      },
    })
    const app = buildServer({ pool: db.pool, cfg, env: testEnv(), logStream: stream })
    // Registered before the first inject: Fastify refuses routes once the router is ready.
    app.get('/test/boom', async () => {
      throw new Error('boom')
    })

    let state = ''
    try {
      state = await newState(app)
      const res = await callback(app, { state, code: 'ashu' })
      expect(res.statusCode).toBe(302)

      await app.inject({ method: 'GET', url: '/test/boom?secret=do-not-log' })
    } finally {
      await app.close()
    }

    const log = lines.join('')
    // The request is still logged, just without its query string.
    expect(log).toContain('/auth/dev/callback')
    expect(log).toContain('/test/boom')
    expect(log).not.toContain(state)
    expect(log).not.toContain('code=ashu')
    expect(log).not.toContain('secret=do-not-log')
  })
})

describe('handle exhaustion', () => {
  it('maps a typed exhaustion to a named 500 instead of the generic internal error', async () => {
    await withApp(async (app) => {
      app.get('/test/handle-exhausted', async () => {
        throw new HandleExhaustedError('Ashu')
      })

      const res = await app.inject({ method: 'GET', url: '/test/handle-exhausted' })

      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({
        error: {
          code: 'handle_exhausted',
          message: 'no free handle based on "Ashu" after 100 attempts',
        },
      })
    })
  })
})

describe('handle generation', () => {
  it('lowercases and keeps only letters, digits and underscores', () => {
    expect(baseHandle('Ashu')).toBe('ashu')
    expect(baseHandle('Ashu TV!')).toBe('ashu_tv')
    expect(baseHandle('--Ashu--TV--')).toBe('ashu_tv')
    expect(baseHandle('Ashu_TV')).toBe('ashu_tv')
  })

  it('falls back when nothing usable is left and truncates to 24 characters', () => {
    expect(baseHandle('!!')).toBe('fan')
    expect(baseHandle('ab')).toBe('fan')
    expect(baseHandle('a'.repeat(30))).toBe('a'.repeat(24))
  })

  it('suffixes collisions with _2, _3 and keeps the result within 24 characters', () => {
    expect(suffixedHandle('ashu', 0)).toBe('ashu')
    expect(suffixedHandle('ashu', 1)).toBe('ashu_2')
    expect(suffixedHandle('ashu', 2)).toBe('ashu_3')

    const longest = suffixedHandle('a'.repeat(24), 1)
    expect(longest).toHaveLength(24)
    expect(longest.endsWith('_2')).toBe(true)
  })

  it('walks the suffixes and gives up instead of looping forever', async () => {
    const attempted: string[] = []
    const refusing: Queryable = {
      async query(text, values) {
        if (text.startsWith('insert into fans')) {
          attempted.push(String(values?.[0]))
          throw { code: '23505', constraint: 'fans_handle_key' }
        }
        return { rows: [] }
      },
    }

    await expect(
      createFanWithUniqueHandle(refusing, { displayHandle: 'ashu', displayName: 'Ashu' }),
    ).rejects.toBeInstanceOf(HandleExhaustedError)
    expect(attempted).toHaveLength(MAX_HANDLE_ATTEMPTS)
    expect(attempted[0]).toBe('ashu')
    expect(attempted[1]).toBe('ashu_2')
  })

  it('creates the fan with the first free handle', async () => {
    await seedFan('ashu')
    const { id, handle } = await withTransaction(db.pool, (tx) =>
      createFanWithUniqueHandle(tx, { displayHandle: 'Ashu', displayName: 'Ashu' }),
    )
    expect(handle).toBe('ashu_2')
    const { rows } = await db.pool.query<{ handle: string }>('select handle from fans where id = $1', [id])
    expect(rows[0]?.handle).toBe('ashu_2')
  })
})
