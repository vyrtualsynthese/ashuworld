import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { GameConfig } from '@ashuworld/gameconfig'
import {
  awardOnce,
  createFan,
  ensureIdentity,
  linkIdentity,
  withTransaction,
  type Queryable,
} from '@ashuworld/ledger'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import type { Env } from '../src/config.js'
import { buildServer } from '../src/server.js'
import {
  SESSION_TTL_SECONDS,
  authenticatedFanId,
  createSession,
  destroySession,
  readSession,
  setSessionCookie,
} from '../src/auth/session.js'
import { readFanProfile } from '../src/routes/me.js'

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

/**
 * The api tests hit a real Postgres, but not the one in `DATABASE_URL`: the pool is
 * injected, so only `TEST_DATABASE_URL` matters and `createTestDb` enforces it.
 */
function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
    SESSION_COOKIE_NAME: 'ashuworld_session',
    COOKIE_SECURE: false,
    ALLOW_DEV_LOGIN: false,
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

/**
 * Builds a server, runs the assertions and always closes the instance. `app.log` is
 * silenced so deliberate failures do not print stacks.
 */
async function withApp(
  run: (app: FastifyInstance) => Promise<void>,
  options: { pool?: Pool; env?: Partial<Env> } = {},
): Promise<void> {
  const app = buildServer({ pool: options.pool ?? db.pool, cfg, env: testEnv(options.env) })
  app.log.level = 'silent'
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

async function seedFan(handle = 'ashu', displayName = 'Ashu'): Promise<string> {
  const { id } = await withTransaction(db.pool, (tx) => createFan(tx, { handle, displayName }))
  return id
}

async function seedSession(fanId: string): Promise<string> {
  return withTransaction(db.pool, (tx) => createSession(tx, fanId))
}

/** An identity attached to the fan, with one earn so the standing is non-zero. */
async function seedEarningIdentity(
  fanId: string,
  options: {
    externalId?: string
    displayHandle?: string
    amount?: number
    idempotencyKey?: string
  } = {},
): Promise<string> {
  const {
    externalId = 'tw-1',
    displayHandle = 'ashu_tv',
    amount = 150,
    idempotencyKey = 'seed-event-1',
  } = options

  return withTransaction(db.pool, async (tx) => {
    const identity = await ensureIdentity(tx, {
      provider: 'twitch',
      externalId,
      displayHandle,
      displayName: displayHandle,
    })
    const linked = await linkIdentity(tx, { fanId, identityId: identity.id, cfg })
    if (!linked.ok) throw new Error(`seeding failed: link refused with ${linked.reason}`)

    const awarded = await awardOnce(tx, {
      identityId: identity.id,
      provider: 'twitch',
      actionKey: 'twitch.follow',
      amount,
      idempotencyKey,
      cfg,
    })
    if (!awarded.awarded) throw new Error('seeding failed: the earn was not paid')
    return identity.id
  })
}

function cookieHeader(sessionId: string, name = 'ashuworld_session'): { cookie: string } {
  return { cookie: `${name}=${sessionId}` }
}

function setCookieOf(res: { headers: Record<string, unknown> }): string {
  return String(res.headers['set-cookie'] ?? '')
}

describe('GET /api/me', () => {
  it('returns the fan behind the session cookie', async () => {
    const fanId = await seedFan()
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(sessionId),
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        id: fanId,
        handle: 'ashu',
        displayName: 'Ashu',
        balance: 0,
        peakXp: 0,
        level: 0,
        identities: [],
      })
    })
  })

  it('returns the live standing and every identity attached to the fan', async () => {
    const fanId = await seedFan()
    const identityId = await seedEarningIdentity(fanId)
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(sessionId),
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        id: fanId,
        handle: 'ashu',
        displayName: 'Ashu',
        balance: 150,
        peakXp: 150,
        level: 1,
        identities: [
          { id: identityId, provider: 'twitch', displayHandle: 'ashu_tv', linked: true },
        ],
      })
    })
  })

  it('rejects a request without a cookie', async () => {
    await seedFan()

    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/me' })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({
        error: { code: 'unauthenticated', message: 'sign in to continue' },
      })
    })
  })

  it('treats an empty cookie value as signed out', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: 'ashuworld_session=' },
      })

      expect(res.statusCode).toBe(401)
    })
  })

  it('treats an expired session as signed out', async () => {
    const fanId = await seedFan()
    const sessionId = await seedSession(fanId)
    await withTransaction(db.pool, async (tx) => {
      await tx.query(`update sessions set expires_at = now() - interval '1 second' where id = $1`, [
        sessionId,
      ])
    })

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(sessionId),
      })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({
        error: { code: 'unauthenticated', message: 'sign in to continue' },
      })
    })
  })

  it('rejects a session id that was never issued', async () => {
    const guessed = randomBytes(32).toString('base64url')

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(guessed),
      })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({
        error: { code: 'unauthenticated', message: 'sign in to continue' },
      })
      expect(res.body).not.toContain(guessed)
    })
  })

  it('rejects a malformed cookie without touching the database', async () => {
    // A pool that fails on connect: if the malformed value reached Postgres this would
    // be a 503 from the store, not the ordinary signed-out answer.
    const untouchedPool = {
      connect: async () => {
        throw new Error('the database must not be queried for a malformed session id')
      },
    } as unknown as Pool

    await withApp(
      async (app) => {
        for (const malformed of ['not-a-session', 'x'.repeat(42), 'x'.repeat(44), 'abc$def']) {
          const res = await app.inject({
            method: 'GET',
            url: '/api/me',
            headers: cookieHeader(malformed),
          })

          expect(res.statusCode).toBe(401)
          expect(res.json()).toEqual({
            error: { code: 'unauthenticated', message: 'sign in to continue' },
          })
          expect(res.body).not.toContain(malformed)
        }
      },
      { pool: untouchedPool },
    )
  })

  it('never echoes the session id in its body', async () => {    const fanId = await seedFan()
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(sessionId),
      })

      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain(sessionId)
    })
  })

  it('reads the cookie name from the environment', async () => {
    const fanId = await seedFan()
    const sessionId = await seedSession(fanId)
    const env = testEnv({ SESSION_COOKIE_NAME: 'ashu_dev' })

    await withApp(
      async (app) => {
        const accepted = await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: cookieHeader(sessionId, 'ashu_dev'),
        })
        expect(accepted.statusCode).toBe(200)

        const refused = await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: cookieHeader(sessionId),
        })
        expect(refused.statusCode).toBe(401)
      },
      { env },
    )
  })

  it('answers 503 when the session store is unreachable instead of throwing', async () => {
    const brokenPool = {
      connect: async () => {
        throw new Error('connection refused')
      },
    } as unknown as Pool

    await withApp(
      async (app) => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: cookieHeader(randomBytes(32).toString('base64url')),
        })

        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({
          error: {
            code: 'database_unavailable',
            message: 'the database did not answer the session lookup',
          },
        })
      },
      { pool: brokenPool },
    )
  })
})

describe('fan isolation', () => {
  it('returns only the signed-in fan, whatever ids the caller supplies', async () => {
    const fanA = await seedFan('ashu', 'Ashu')
    const fanB = await seedFan('bob', 'Bob')
    const identityA = await seedEarningIdentity(fanA, {
      externalId: 'tw-a',
      displayHandle: 'ashu_tv',
      amount: 150,
      idempotencyKey: 'evt-a',
    })
    const identityB = await seedEarningIdentity(fanB, {
      externalId: 'tw-b',
      displayHandle: 'bob_tv',
      amount: 350,
      idempotencyKey: 'evt-b',
    })
    const sessionA = await seedSession(fanA)
    const sessionB = await seedSession(fanB)

    await withApp(async (app) => {
      const asA = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(sessionA),
      })
      expect(asA.statusCode).toBe(200)
      const profileA = asA.json() as {
        id: string
        handle: string
        level: number
        identities: Array<{ id: string }>
      }
      expect(profileA.id).toBe(fanA)
      expect(profileA.handle).toBe('ashu')
      expect(profileA.level).toBe(1)
      expect(profileA.identities.map((identity) => identity.id)).toEqual([identityA])
      // A's payload must carry nothing that belongs to B.
      expect(profileA.identities.map((identity) => identity.id)).not.toContain(identityB)
      expect(asA.body).not.toContain('bob')
      expect(asA.body).not.toContain(identityB)

      const asB = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(sessionB),
      })
      expect(asB.statusCode).toBe(200)
      const profileB = asB.json() as {
        id: string
        handle: string
        level: number
        identities: Array<{ id: string }>
      }
      expect(profileB.id).toBe(fanB)
      expect(profileB.handle).toBe('bob')
      expect(profileB.level).toBe(2)
      expect(profileB.identities.map((identity) => identity.id)).toEqual([identityB])
      expect(profileB.identities.map((identity) => identity.id)).not.toContain(identityA)
      expect(asB.body).not.toContain(fanA)

      // A fan id in the query, in a header, or in a body must not change whose profile
      // the session resolves to. The only id that matters is the one in the cookie.
      const spoofed = await app.inject({
        method: 'GET',
        url: `/api/me?fanId=${fanB}`,
        headers: {
          ...cookieHeader(sessionA),
          'content-type': 'application/json',
          'x-fan-id': fanB,
        },
        payload: { fanId: fanB },
      })
      expect(spoofed.statusCode).toBe(200)
      const spoofedProfile = spoofed.json() as {
        id: string
        handle: string
        identities: Array<{ id: string }>
      }
      expect(spoofedProfile.id).toBe(fanA)
      expect(spoofedProfile.handle).toBe('ashu')
      expect(spoofedProfile.identities.map((identity) => identity.id)).toEqual([identityA])
    })
  })
})

describe('session store', () => {
  it('stores an unguessable id verbatim with a 30-day expiry', async () => {
    const fanId = await seedFan()

    const stored = await withTransaction(db.pool, async (tx) => {
      const id = await createSession(tx, fanId)
      const { rows } = await tx.query<{
        fan_id: string
        expires_in_seconds: number
      }>(
        `select fan_id,
                extract(epoch from expires_at - now())::int as expires_in_seconds
           from sessions
          where id = $1`,
        [id],
      )
      return { id, row: rows[0] }
    })

    expect(stored.id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(stored.row?.fan_id).toBe(fanId)
    // Both timestamps come from the database clock, so this is not comparing two clocks.
    expect(stored.row?.expires_in_seconds).toBeGreaterThan(SESSION_TTL_SECONDS - 5)
    expect(stored.row?.expires_in_seconds).toBeLessThanOrEqual(SESSION_TTL_SECONDS)
  })

  it('issues a different id for every session', async () => {
    const fanId = await seedFan()

    const ids = await withTransaction(db.pool, async (tx) => [
      await createSession(tx, fanId),
      await createSession(tx, fanId),
    ])

    expect(ids[0]).not.toBe(ids[1])
  })

  it('reads a live session and answers null for an unknown one', async () => {
    const fanId = await seedFan()
    const sessionId = await seedSession(fanId)

    const live = await withTransaction(db.pool, (tx) => readSession(tx, sessionId))
    const missing = await withTransaction(db.pool, (tx) => readSession(tx, 'never-issued'))

    expect(live).toEqual({ fanId })
    expect(missing).toBeNull()
  })

  it('answers null for a malformed id without querying the database', async () => {
    const neverQueried: Queryable = {
      query: async () => {
        throw new Error('readSession queried the database for a malformed id')
      },
    }

    await expect(readSession(neverQueried, 'short')).resolves.toBeNull()
    await expect(readSession(neverQueried, 'x'.repeat(44))).resolves.toBeNull()
    await expect(readSession(neverQueried, 'abc$def')).resolves.toBeNull()
  })

  it('reads an expired session as null', async () => {    const fanId = await seedFan()
    const sessionId = await seedSession(fanId)
    await withTransaction(db.pool, async (tx) => {
      await tx.query(`update sessions set expires_at = now() - interval '1 second' where id = $1`, [
        sessionId,
      ])
    })

    await expect(withTransaction(db.pool, (tx) => readSession(tx, sessionId))).resolves.toBeNull()
  })

  it('destroys a session, and destroying an unknown id is a no-op', async () => {
    const fanId = await seedFan()
    const sessionId = await seedSession(fanId)

    await withTransaction(db.pool, (tx) => destroySession(tx, sessionId))
    await expect(withTransaction(db.pool, (tx) => readSession(tx, sessionId))).resolves.toBeNull()
    await expect(
      withTransaction(db.pool, (tx) => destroySession(tx, 'never-issued')),
    ).resolves.toBeUndefined()
  })

  it('refuses a handler that runs without the preHandler', () => {
    expect(() => authenticatedFanId({} as unknown as FastifyRequest)).toThrow(/requireFan/)
  })

  it('fails loudly when a profile read finds no fan row', async () => {
    const empty: Queryable = { query: async () => ({ rows: [] }) }

    await expect(readFanProfile(empty, 'missing-fan')).rejects.toThrow(/no fans row/)
  })
})

describe('POST /auth/logout', () => {
  it('destroys the session and clears the cookie', async () => {
    const fanId = await seedFan()
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: cookieHeader(sessionId),
      })

      expect(res.statusCode).toBe(204)
      const setCookie = setCookieOf(res)
      expect(setCookie).toContain('ashuworld_session=')
      expect(setCookie).toContain('Max-Age=0')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Lax')
      expect(setCookie).toContain('Path=/')
      expect(setCookie).not.toContain(sessionId)

      const after = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(sessionId),
      })
      expect(after.statusCode).toBe(401)
    })
  })

  it('clears the cookie even when the session row cannot be deleted', async () => {
    // The transaction opens, then the delete itself is refused. A sign-out that answers
    // 500 here would leave the browser holding a cookie whose server row is still live.
    const failingDeletePool = {
      connect: async () => ({
        query: async (text: string) => {
          if (String(text).startsWith('delete from sessions')) {
            throw new Error('the delete was refused')
          }
          return { rows: [] }
        },
        release: () => undefined,
      }),
    } as unknown as Pool
    const sessionId = randomBytes(32).toString('base64url')

    await withApp(
      async (app) => {
        const res = await app.inject({
          method: 'POST',
          url: '/auth/logout',
          headers: cookieHeader(sessionId),
        })

        expect(res.statusCode).toBe(204)
        const setCookie = setCookieOf(res)
        expect(setCookie).toContain('Max-Age=0')
        expect(setCookie).toContain('HttpOnly')
        expect(setCookie).toContain('SameSite=Lax')
        expect(setCookie).not.toContain(sessionId)
      },
      { pool: failingDeletePool },
    )
  })

  it('is idempotent without a cookie', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'POST', url: '/auth/logout' })

      expect(res.statusCode).toBe(204)
      expect(res.body).toBe('')
      expect(setCookieOf(res)).toContain('Max-Age=0')
    })
  })

  it('is idempotent for a session id that was never issued', async () => {
    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: cookieHeader(randomBytes(32).toString('base64url')),
      })

      expect(res.statusCode).toBe(204)
    })
  })
})

describe('session cookie attributes', () => {
  it('marks the cookie HttpOnly, SameSite=Lax and Path=/, without Secure when COOKIE_SECURE is false', async () => {
    const env = testEnv({ COOKIE_SECURE: false })

    await withApp(
      async (app) => {
        app.get('/test/session-cookie', async (_request, reply) => {
          setSessionCookie(reply, env, 'issued-session-id')
          return reply.code(204).send()
        })

        const res = await app.inject({ method: 'GET', url: '/test/session-cookie' })
        const setCookie = setCookieOf(res)

        expect(setCookie).toContain('ashuworld_session=issued-session-id')
        expect(setCookie).toContain('HttpOnly')
        expect(setCookie).toContain('SameSite=Lax')
        expect(setCookie).toContain('Path=/')
        expect(setCookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`)
        expect(setCookie).not.toContain('Secure')
      },
      { env },
    )
  })

  it('adds Secure when COOKIE_SECURE is true', async () => {
    const env = testEnv({ COOKIE_SECURE: true })

    await withApp(
      async (app) => {
        app.get('/test/session-cookie', async (_request, reply) => {
          setSessionCookie(reply, env, 'issued-session-id')
          return reply.code(204).send()
        })

        const res = await app.inject({ method: 'GET', url: '/test/session-cookie' })

        expect(setCookieOf(res)).toContain('Secure')
      },
      { env },
    )
  })
})
