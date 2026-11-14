import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GameConfig } from '@ashuworld/gameconfig'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import type { Env } from '../src/config.js'
import { buildServer } from '../src/server.js'
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
  beyond: { step: 1600, factor: 2 },
}

const COOKIE = 'ashuworld_session'
const START = '/auth/dev/start?purpose=login&accept=2026-11-14'
const GAME = '/api/public/game'
const LADDER = '/api/public/ladder'
const HEALTH = '/api/health'
const LOGOUT = '/auth/logout'
const CALLBACK = '/auth/dev/callback'

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
    SESSION_COOKIE_NAME: COOKIE,
    COOKIE_SECURE: false,
    ALLOW_DEV_LOGIN: true,
    TRUST_PROXY: false,
    PUBLIC_BASE_URL: 'http://localhost:3000',
    PORT: 3000,
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_PUBLIC_MAX: 120,
    RATE_LIMIT_AUTH_MAX: 20,
    RATE_LIMIT_WRITE_MAX: 10,
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

/**
 * Builds a server with its own rate-limit store, runs the assertions and always closes
 * it. Every scenario needs a fresh store: an exhausted bucket would otherwise leak from
 * one test into the next.
 */
async function withApp(
  env: Partial<Env>,
  run: (app: FastifyInstance) => Promise<void>,
): Promise<void> {
  const app = buildServer({ pool: db.pool, cfg, env: testEnv(env) })
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

/**
 * The `set-cookie` header as a list. Fastify sends one string for a single cookie and an
 * array for several, and these scenarios read both the binding cookie and the session.
 */
function cookiesOf(res: Injected): string[] {
  const header = res.headers['set-cookie']
  if (header === undefined) return []
  return Array.isArray(header) ? header.map(String) : [String(header)]
}

function cookieNamed(res: Injected, name: string): string | undefined {
  return cookiesOf(res).find((cookie) => cookie.startsWith(`${name}=`))
}

/** The value half of a `set-cookie` line, without attributes or surrounding quotes. */
function cookieValue(cookie: string): string {
  const pair = cookie.split(';')[0] ?? ''
  return pair.slice(pair.indexOf('=') + 1)
}

function valueOf(res: Injected, name: string): string {
  const cookie = cookieNamed(res, name)
  if (cookie === undefined) throw new Error(`the response set no ${name} cookie`)
  return cookieValue(cookie)
}

/** The `state` the start redirect carries; the callback has to present it back. */
function stateOf(res: Injected): string {
  const location = res.headers['location']
  if (typeof location !== 'string') throw new Error('the start has no Location header')
  const state = new URL(location).searchParams.get('state')
  if (state === null) throw new Error('the redirect carries no state')
  return state
}

/**
 * Signs in through the dev door and returns the session cookie the callback set.
 *
 * Two requests, both in the auth bucket: a start that records the handshake and a callback
 * that proves the identity. The browser-binding cookie comes back from the start, as it
 * would in a browser.
 */
async function signIn(app: FastifyInstance): Promise<string> {
  const start = await app.inject({ method: 'GET', url: START })
  if (start.statusCode !== 302) throw new Error(`start answered ${start.statusCode}: ${start.body}`)

  const state = stateOf(start)
  const binding = valueOf(start, OAUTH_STATE_COOKIE_NAME)
  const res = await app.inject({
    method: 'GET',
    url: `${CALLBACK}?state=${encodeURIComponent(state)}&code=ashu`,
    headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=${binding}` },
  })
  if (res.statusCode !== 302) throw new Error(`callback answered ${res.statusCode}: ${res.body}`)
  return valueOf(res, COOKIE)
}

/** The env every sign-in scenario starts from, with the auth budget set to two. */
const LIMITED = {
  RATE_LIMIT_ENABLED: true,
  RATE_LIMIT_AUTH_MAX: 2,
  ALLOW_DEV_LOGIN: true,
} satisfies Partial<Env>

describe('rate limiting', () => {
  it('refuses a third sign-in start in the window with the shared envelope', async () => {
    await withApp(LIMITED, async (app) => {
      const first = await app.inject({ method: 'GET', url: START })
      const second = await app.inject({ method: 'GET', url: START })
      expect(first.statusCode).toBe(302)
      expect(second.statusCode).toBe(302)

      const third = await app.inject({ method: 'GET', url: START })
      expect(third.statusCode).toBe(429)
      expect(third.json()).toEqual({
        error: { code: 'rate_limited', message: expect.any(String) },
      })
      expect(third.headers['retry-after']).toBeDefined()
    })
  })

  it('exempts only the health probe from the public budget', async () => {
    // The public budget is five, so an unexempt probe would answer 429 from the sixth on.
    await withApp(
      { RATE_LIMIT_ENABLED: true, RATE_LIMIT_PUBLIC_MAX: 5, ALLOW_DEV_LOGIN: true },
      async (app) => {
        // Exhaust the public bucket first: this proves the limiter is actually on.
        for (let i = 0; i < 5; i += 1) {
          expect((await app.inject({ method: 'GET', url: GAME })).statusCode).toBe(200)
        }
        expect((await app.inject({ method: 'GET', url: GAME })).statusCode).toBe(429)

        // The probe still answers while that bucket is exhausted, which only the exemption
        // can explain: an excluded route is not counted, not merely unblocked.
        for (let i = 0; i < 10; i += 1) {
          expect((await app.inject({ method: 'GET', url: HEALTH })).statusCode).toBe(200)
        }
      },
    )
  })

  it('keeps the ladder readable while sign-in is limited', async () => {
    await withApp(LIMITED, async (app) => {
      for (let i = 0; i < 2; i += 1) {
        expect((await app.inject({ method: 'GET', url: START })).statusCode).toBe(302)
      }
      const third = await app.inject({ method: 'GET', url: START })
      expect(third.statusCode).toBe(429)

      const ladder = await app.inject({ method: 'GET', url: LADDER })
      expect(ladder.statusCode).toBe(200)
    })
  })

  it('does nothing when RATE_LIMIT_ENABLED is false', async () => {
    // Both budgets are two, so a registered limiter would refuse the third start.
    await withApp(
      { RATE_LIMIT_ENABLED: false, RATE_LIMIT_AUTH_MAX: 2, RATE_LIMIT_PUBLIC_MAX: 2 },
      async (app) => {
        for (let i = 0; i < 10; i += 1) {
          const res = await app.inject({ method: 'GET', url: START })
          expect(res.statusCode).toBe(302)
        }
      },
    )
  })

  it('counts destructive writes against their own budget', async () => {
    await withApp(
      {
        RATE_LIMIT_ENABLED: true,
        ALLOW_DEV_LOGIN: true,
        RATE_LIMIT_AUTH_MAX: 100,
        RATE_LIMIT_PUBLIC_MAX: 100,
        RATE_LIMIT_WRITE_MAX: 1,
      },
      async (app) => {
        const session = await signIn(app)
        const headers = { cookie: `${COOKIE}=${session}` }

        const me = await app.inject({ method: 'GET', url: '/api/me', headers })
        expect(me.statusCode).toBe(200)
        const profile = me.json() as { identities: Array<{ id: string }> }
        const identityId = profile.identities[0]?.id
        if (identityId === undefined) throw new Error('the signed-in fan has no identity')

        // The fan holds one identity, so the detach is refused — but it is a write attempt,
        // and the first one is the only one the budget allows.
        const detachUrl = `/api/me/identities/${identityId}/detach`
        const first = await app.inject({ method: 'POST', url: detachUrl, headers })
        expect(first.statusCode).toBe(409)
        expect(first.json()).toMatchObject({ error: { code: 'last_identity' } })

        const second = await app.inject({ method: 'POST', url: detachUrl, headers })
        expect(second.statusCode).toBe(429)
        expect(second.json()).toEqual({
          error: { code: 'rate_limited', message: expect.any(String) },
        })

        // The write bucket is separate from the public one.
        expect((await app.inject({ method: 'GET', url: LADDER })).statusCode).toBe(200)
      },
    )
  })

  it('gives the callback the auth budget instead of the public one', async () => {
    await withApp(
      {
        RATE_LIMIT_ENABLED: true,
        ALLOW_DEV_LOGIN: true,
        RATE_LIMIT_AUTH_MAX: 2,
        RATE_LIMIT_PUBLIC_MAX: 100,
      },
      async (app) => {
        const first = await app.inject({ method: 'GET', url: START })
        const second = await app.inject({ method: 'GET', url: START })
        expect(first.statusCode).toBe(302)
        expect(second.statusCode).toBe(302)

        const exchange = (start: Injected): Promise<Injected> =>
          app.inject({
            method: 'GET',
            url: `${CALLBACK}?state=${encodeURIComponent(stateOf(start))}&code=ashu`,
            headers: {
              cookie: `${OAUTH_STATE_COOKIE_NAME}=${valueOf(start, OAUTH_STATE_COOKIE_NAME)}`,
            },
          })

        // A real sign-in twice, which uses the callback budget up.
        expect((await exchange(first)).statusCode).toBe(302)
        expect((await exchange(second)).statusCode).toBe(302)

        // The third is refused by the limiter before the handler runs. Without the route's
        // override it would fall into the 100/min public bucket and answer 400 instead,
        // because the first handshake is already spent.
        const third = await exchange(first)
        expect(third.statusCode).toBe(429)
        expect(third.json()).toEqual({
          error: { code: 'rate_limited', message: expect.any(String) },
        })
      },
    )
  })

  it('gives logout the auth budget instead of the public one', async () => {
    await withApp(
      {
        RATE_LIMIT_ENABLED: true,
        ALLOW_DEV_LOGIN: true,
        RATE_LIMIT_AUTH_MAX: 1,
        RATE_LIMIT_PUBLIC_MAX: 100,
      },
      async (app) => {
        // A sign-out always works once; the second one in the window is the abuse case.
        expect((await app.inject({ method: 'POST', url: LOGOUT })).statusCode).toBe(204)

        const second = await app.inject({ method: 'POST', url: LOGOUT })
        // Without the route's override this would be a 204 from the public bucket.
        expect(second.statusCode).toBe(429)
        expect(second.json()).toEqual({
          error: { code: 'rate_limited', message: expect.any(String) },
        })
      },
    )
  })
})
