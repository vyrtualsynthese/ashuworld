import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { GameConfig } from '@ashuworld/gameconfig'
import {
  awardOnce,
  createFan,
  detachIdentity,
  ensureIdentity,
  linkIdentity,
  withTransaction,
} from '@ashuworld/ledger'
import type { ProviderName } from '@ashuworld/providers'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import type { Env } from '../src/config.js'
import { buildServer } from '../src/server.js'
import { createSession } from '../src/auth/session.js'

const cfg: GameConfig = {
  version: 'test',
  actions: {
    'twitch.follow': { amount: 50, provider: 'twitch' },
    'youtube.subscribe': { amount: 100, provider: 'youtube' },
    'discord.member': { amount: 75, provider: 'discord' },
  },
  levels: [
    { level: 0, minXp: 0 },
    { level: 1, minXp: 100 },
    { level: 2, minXp: 300 },
  ],
  beyond: { step: 1600, factor: 2 },
}

const COOKIE = 'ashuworld_session'
const NOT_FOUND = {
  error: { code: 'not_found', message: 'the requested resource does not exist' },
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
    SESSION_COOKIE_NAME: COOKIE,
    COOKIE_SECURE: false,
    ALLOW_DEV_LOGIN: false,
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

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = buildServer({ pool: db.pool, cfg, env: testEnv() })
  app.log.level = 'silent'
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

async function seedFan(handle: string, displayName = handle): Promise<string> {
  const { id } = await withTransaction(db.pool, (tx) =>
    createFan(tx, { handle, displayName }),
  )
  return id
}

async function seedIdentity(
  provider: ProviderName,
  externalId: string,
  displayHandle: string,
): Promise<string> {
  const { id } = await withTransaction(db.pool, (tx) =>
    ensureIdentity(tx, { provider, externalId, displayHandle, displayName: displayHandle }),
  )
  return id
}

async function link(fanId: string, identityId: string): Promise<void> {
  const result = await withTransaction(db.pool, (tx) =>
    linkIdentity(tx, { fanId, identityId, cfg }),
  )
  if (!result.ok) throw new Error(`seeding failed: link refused with ${result.reason}`)
}

async function award(
  identityId: string,
  provider: ProviderName,
  actionKey: string,
  amount: number,
  idempotencyKey: string,
): Promise<void> {
  const result = await withTransaction(db.pool, (tx) =>
    awardOnce(tx, { identityId, provider, actionKey, amount, idempotencyKey, cfg }),
  )
  if (!result.awarded) throw new Error('seeding failed: the earn was not paid')
}

describe('GET /api/public/ladder', () => {
  it('serves the ladder to a request with no cookie and no session', async () => {
    const fanId = await seedFan('ashu', 'Ashu')
    const twitch = await seedIdentity('twitch', 't-ashu', 'ashu_tv')
    await link(fanId, twitch)
    await award(twitch, 'twitch', 'twitch.follow', 150, 'ashu-earn')

    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/public/ladder' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        linked: [{ fanId, handle: 'ashu', level: 1, balance: 150 }],
        freeStanding: [],
      })
      expect(res.headers['set-cookie']).toBeUndefined()
      // The ladder is the same for everyone and moves at the speed of an earn, not a
      // click, so a short public window is safe and keeps a shared link off the origin.
      expect(res.headers['cache-control']).toBe('public, max-age=15')
    })
  })

  it('serves a never-linked earning identity as a free-standing row', async () => {
    const fanId = await seedFan('ashu', 'Ashu')
    const twitch = await seedIdentity('twitch', 't-ashu', 'ashu_tv')
    await link(fanId, twitch)
    await award(twitch, 'twitch', 'twitch.follow', 50, 'ashu-earn')
    // Nobody has ever claimed this one; its earn still counts, on its own row.
    const unclaimed = await seedIdentity('youtube', 'y-unclaimed', 'unclaimed_yt')
    await award(unclaimed, 'youtube', 'youtube.subscribe', 100, 'unclaimed-earn')

    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/public/ladder' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        linked: [{ fanId, handle: 'ashu', level: 0, balance: 50 }],
        freeStanding: [
          {
            identityId: unclaimed,
            provider: 'youtube',
            displayHandle: 'unclaimed_yt',
            xp: 100,
          },
        ],
      })
    })
  })

  // The isolation level is issued by the route, which is exactly the kind of line a later
  // refactor drops without any test noticing: the responses are identical either way. The
  // pool is instrumented, so the check runs on the same client, after the route's own
  // statement, before the transaction commits.
  it('reads the ladder inside a repeatable-read transaction', async () => {
    await seedFan('ashu', 'Ashu')

    const seen: string[] = []
    // A client returned to the pool is reused by later tests, and pg-pool also calls
    // `query` callback-style, which an async replacement would swallow. Every patched
    // client is therefore put back exactly as it was once the request is over.
    const restores: Array<() => void> = []
    const tracing = {
      connect: async () => {
        const client = await db.pool.connect()
        const raw = client as unknown as {
          query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
        }
        const original = raw.query.bind(raw)
        raw.query = async (text, values) => {
          const result = await original(text, values)
          if (/set transaction isolation level/i.test(text)) {
            const { rows } = await original("select current_setting('transaction_isolation') as level")
            seen.push(String(rows[0]?.['level']))
          }
          return result
        }
        restores.push(() => {
          raw.query = original
        })
        return client
      },
    } as unknown as Pool

    const app = buildServer({ pool: tracing, cfg, env: testEnv() })
    app.log.level = 'silent'
    try {
      const res = await app.inject({ method: 'GET', url: '/api/public/ladder' })
      expect(res.statusCode).toBe(200)
    } finally {
      await app.close()
      for (const restore of restores) restore()
    }

    // Empty means the route never asked for repeatable read; any other value means it
    // asked and the database said no.
    expect(seen).toEqual(['repeatable read'])
  })

  it('answers the same ladder whether or not the request carries a session', async () => {
    const fanId = await seedFan('ashu', 'Ashu')
    const twitch = await seedIdentity('twitch', 't-ashu', 'ashu_tv')
    await link(fanId, twitch)
    await award(twitch, 'twitch', 'twitch.follow', 150, 'ashu-earn')
    const sessionId = await withTransaction(db.pool, (tx) => createSession(tx, fanId))

    await withApp(async (app) => {
      const anonymous = await app.inject({ method: 'GET', url: '/api/public/ladder' })
      const signedIn = await app.inject({
        method: 'GET',
        url: '/api/public/ladder',
        headers: { cookie: `${COOKIE}=${sessionId}` },
      })

      expect(signedIn.statusCode).toBe(200)
      // The session is ignored, not honoured: the body is byte-for-byte the same and no
      // cookie is refreshed or set.
      expect(signedIn.body).toBe(anonymous.body)
      expect(signedIn.headers['set-cookie']).toBeUndefined()
    })
  })
})

describe('GET /api/public/game', () => {
  it('serves the actions and levels to a request with no cookie and no session', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/public/game' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        // Highest amount first: youtube 100, discord 75, twitch 50.
        actions: [
          {
            key: 'youtube.subscribe',
            provider: 'youtube',
            amount: 100,
            monthly: 0,
            label: 'youtube.subscribe',
            description: '',
          },
          {
            key: 'discord.member',
            provider: 'discord',
            amount: 75,
            monthly: 0,
            label: 'discord.member',
            description: '',
          },
          {
            key: 'twitch.follow',
            provider: 'twitch',
            amount: 50,
            monthly: 0,
            label: 'twitch.follow',
            description: '',
          },
        ],
        levels: [
          { level: 0, minXp: 0 },
          { level: 1, minXp: 100 },
          { level: 2, minXp: 300 },
          { level: 3, minXp: 1900 },
          { level: 4, minXp: 5100 },
          { level: 5, minXp: 11500 },
          { level: 6, minXp: 24300 },
          { level: 7, minXp: 49900 },
          { level: 8, minXp: 101100 },
          { level: 9, minXp: 203500 },
          { level: 10, minXp: 408300 },
        ],
      })
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(res.headers['cache-control']).toBe('public, max-age=15')
    })
  })

  it('answers the same rules whether or not the request carries a session', async () => {
    const fanId = await seedFan('ashu', 'Ashu')
    const sessionId = await withTransaction(db.pool, (tx) => createSession(tx, fanId))

    await withApp(async (app) => {
      const anonymous = await app.inject({ method: 'GET', url: '/api/public/game' })
      const signedIn = await app.inject({
        method: 'GET',
        url: '/api/public/game',
        headers: { cookie: `${COOKIE}=${sessionId}` },
      })

      expect(signedIn.statusCode).toBe(200)
      // The session is ignored, not honoured: same bytes, no refreshed or new cookie.
      expect(signedIn.body).toBe(anonymous.body)
      expect(signedIn.headers['set-cookie']).toBeUndefined()
      expect(signedIn.headers['cache-control']).toBe(anonymous.headers['cache-control'])
    })
  })

  it('takes every value from the config the server was built with', async () => {
    const conniving: GameConfig = {
      version: 'never-public',
      actions: {
        'zeta.follow': {
          amount: 999,
          monthly: 3,
          provider: 'twitch',
          label: 'Suivre Zeta',
          description: 'Une seule fois.',
        },
        'alpha.member': {
          amount: 999,
          monthly: 4,
          provider: 'discord',
          label: 'Rejoindre Alpha',
          description: 'Une seule fois aussi.',
        },
      },
      levels: [
        { level: 0, minXp: 0 },
        { level: 1, minXp: 42 },
      ],
      beyond: { step: 1600, factor: 2 },
    }

    const app = buildServer({ pool: db.pool, cfg: conniving, env: testEnv() })
    app.log.level = 'silent'
    try {
      const res = await app.inject({ method: 'GET', url: '/api/public/game' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        // The tie at 999 is broken by key, not by insertion order.
        actions: [
          {
            key: 'alpha.member',
            provider: 'discord',
            amount: 999,
            monthly: 4,
            label: 'Rejoindre Alpha',
            description: 'Une seule fois aussi.',
          },
          {
            key: 'zeta.follow',
            provider: 'twitch',
            amount: 999,
            monthly: 3,
            label: 'Suivre Zeta',
            description: 'Une seule fois.',
          },
        ],
        levels: [
          { level: 0, minXp: 0 },
          { level: 1, minXp: 42 },
          { level: 2, minXp: 1642 },
          { level: 3, minXp: 4842 },
          { level: 4, minXp: 11242 },
          { level: 5, minXp: 24042 },
          { level: 6, minXp: 49642 },
          { level: 7, minXp: 100842 },
          { level: 8, minXp: 203242 },
          { level: 9, minXp: 408042 },
          { level: 10, minXp: 817642 },
        ],
      })
    } finally {
      await app.close()
    }
  })

  it('exposes nothing from the config beyond the six rule fields', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/public/game' })
      const body = res.json() as Record<string, unknown>

      // The config also carries a version; it must not travel with the rules.
      expect(Object.keys(body).sort()).toEqual(['actions', 'levels'])
      for (const action of body['actions'] as Array<Record<string, unknown>>) {
        expect(Object.keys(action).sort()).toEqual([
          'amount',
          'description',
          'key',
          'label',
          'monthly',
          'provider',
        ])
      }
      for (const level of body['levels'] as Array<Record<string, unknown>>) {
        expect(Object.keys(level).sort()).toEqual(['level', 'minXp'])
      }
    })
  })
})

describe('GET /api/public/fans/:handle', () => {
  it('serves a public profile without a session, case-insensitively', async () => {
    const fanId = await seedFan('ashu', 'Ashu')
    const twitch = await seedIdentity('twitch', 't-ashu', 'ashu_tv')
    await link(fanId, twitch)
    await award(twitch, 'twitch', 'twitch.follow', 150, 'ashu-earn')

    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/public/fans/ASHU' })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        id: fanId,
        handle: 'ashu',
        displayName: 'Ashu',
        level: 1,
        balance: 150,
        peakXp: 150,
        identities: [{ provider: 'twitch', displayHandle: 'ashu_tv' }],
      })
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(res.headers['cache-control']).toBe('public, max-age=15')
    })
  })

  it('answers the same profile whether or not the request carries a session', async () => {
    const fanId = await seedFan('ashu', 'Ashu')
    const twitch = await seedIdentity('twitch', 't-ashu', 'ashu_tv')
    await link(fanId, twitch)
    await award(twitch, 'twitch', 'twitch.follow', 150, 'ashu-earn')
    const sessionId = await withTransaction(db.pool, (tx) => createSession(tx, fanId))

    await withApp(async (app) => {
      const anonymous = await app.inject({ method: 'GET', url: '/api/public/fans/ashu' })
      const signedIn = await app.inject({
        method: 'GET',
        url: '/api/public/fans/ashu',
        headers: { cookie: `${COOKIE}=${sessionId}` },
      })

      expect(signedIn.statusCode).toBe(200)
      // Same rule as the ladder: the session is ignored, not honoured, and never refreshed.
      expect(signedIn.body).toBe(anonymous.body)
      expect(signedIn.headers['set-cookie']).toBeUndefined()
      expect(signedIn.headers['cache-control']).toBe(anonymous.headers['cache-control'])
    })
  })

  it('404s an unknown handle with the shared not-found body', async () => {
    const fanId = await seedFan('ashu', 'Ashu')
    await link(fanId, await seedIdentity('twitch', 't-ashu', 'ashu_tv'))

    await withApp(async (app) => {
      // A known handle answers 200, so the 404 below is about the missing fan rather than
      // about the route not existing.
      const known = await app.inject({ method: 'GET', url: '/api/public/fans/ashu' })
      expect(known.statusCode).toBe(200)

      const unknown = await app.inject({ method: 'GET', url: '/api/public/fans/nobody' })
      const noRoute = await app.inject({ method: 'GET', url: '/api/public/nothing' })

      expect(unknown.statusCode).toBe(404)
      expect(unknown.json()).toEqual(NOT_FOUND)
      // A fan that does not exist answers exactly like a path that does not exist, so the
      // response cannot be used to enumerate who has an account.
      expect(unknown.body).toBe(noRoute.body)
      expect(unknown.headers['content-type']).toBe(noRoute.headers['content-type'])
      // A 404 is heuristically cacheable. Without this, a CDN could keep answering "not
      // found" for a handle that was registered after it cached the answer.
      expect(unknown.headers['cache-control']).toBe('no-store')
    })
  })

  it('never exposes provider external ids, session ids or audit data publicly', async () => {
    const twitchExternalId = 'twitch-external-id-4f21c8'
    const youtubeExternalId = 'youtube-external-id-92ae07'
    const fanId = await seedFan('ashu', 'Ashu')
    const twitch = await seedIdentity('twitch', twitchExternalId, 'ashu_tv')
    const youtube = await seedIdentity('youtube', youtubeExternalId, 'ashu_yt')
    await link(fanId, twitch)
    await link(fanId, youtube)
    await award(twitch, 'twitch', 'twitch.follow', 150, 'ashu-earn')
    // A detach writes an audit row; nothing from it may reach a public payload either.
    await withTransaction(db.pool, (tx) =>
      detachIdentity(tx, { fanId, identityId: twitch, cfg }),
    )
    const sessionId = await withTransaction(db.pool, (tx) => createSession(tx, fanId))

    await withApp(async (app) => {
      // The signed-in request is the stronger check: a cookie must not widen the payload.
      const headers = { cookie: `${COOKIE}=${sessionId}` }
      const ladder = await app.inject({ method: 'GET', url: '/api/public/ladder', headers })
      const profile = await app.inject({
        method: 'GET',
        url: '/api/public/fans/ashu',
        headers,
      })
      expect(ladder.statusCode).toBe(200)
      expect(profile.statusCode).toBe(200)

      const forbiddenValues = [
        twitchExternalId,
        youtubeExternalId,
        sessionId,
        'external_id',
        'externalId',
      ]
      for (const res of [ladder, profile]) {
        for (const value of forbiddenValues) {
          expect(res.body).not.toContain(value)
        }
      }

      // The bodies are parsed as well as scanned as text: a key named like an internal
      // identifier is a leak even when its value looks harmless.
      const forbiddenKeys = [
        'externalId',
        'external_id',
        'sessionId',
        'session_id',
        'audit_log',
        'auditLog',
        'forfeitedAt',
        'forfeited_at',
      ]
      expect(publicKeys(ladder.json())).toEqual(
        expect.not.arrayContaining(forbiddenKeys),
      )
      expect(publicKeys(profile.json())).toEqual(
        expect.not.arrayContaining(forbiddenKeys),
      )
      // No email-like field exists in this system, so any such key is a leak by definition.
      expect(publicKeys(ladder.json()).filter((key) => /email/i.test(key))).toEqual([])
      expect(publicKeys(profile.json()).filter((key) => /email/i.test(key))).toEqual([])
    })
  })
})

/**
 * Every object key in a payload, at any depth. A flat `Object.keys` would miss an
 * identifier tucked into an identity object, which is exactly where one would hide.
 */
function publicKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) publicKeys(item, keys)
    return keys
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key)
      publicKeys(child, keys)
    }
  }
  return keys
}
