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
    })
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
