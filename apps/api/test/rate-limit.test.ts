import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GameConfig } from '@ashuworld/gameconfig'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import type { Env } from '../src/config.js'
import { buildServer } from '../src/server.js'

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

const START = '/auth/dev/start?purpose=login&accept=2026-11-14'

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: 'postgres://unused:unused@localhost:5432/unused',
    SESSION_COOKIE_NAME: 'ashuworld_session',
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

/** The env every scenario below starts from, with the auth budget set to two. */
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

  it('leaves the health probe unlimited', async () => {
    await withApp(LIMITED, async (app) => {
      for (let i = 0; i < 10; i += 1) {
        const res = await app.inject({ method: 'GET', url: '/api/health' })
        expect(res.statusCode).toBe(200)
      }
    })
  })

  it('keeps the ladder readable while sign-in is limited', async () => {
    await withApp(LIMITED, async (app) => {
      for (let i = 0; i < 2; i += 1) {
        expect((await app.inject({ method: 'GET', url: START })).statusCode).toBe(302)
      }
      const third = await app.inject({ method: 'GET', url: START })
      expect(third.statusCode).toBe(429)

      const ladder = await app.inject({ method: 'GET', url: '/api/public/ladder' })
      expect(ladder.statusCode).toBe(200)
    })
  })

  it('does nothing when RATE_LIMIT_ENABLED is false', async () => {
    await withApp({ RATE_LIMIT_ENABLED: false, ALLOW_DEV_LOGIN: true }, async (app) => {
      for (let i = 0; i < 10; i += 1) {
        const res = await app.inject({ method: 'GET', url: START })
        expect([302, 400]).toContain(res.statusCode)
      }
    })
  })
})
