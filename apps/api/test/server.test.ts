import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { ConfigError, type GameConfig } from '@ashuworld/gameconfig'
import {
  AwardConflictError,
  HandleTakenError,
  PenaltyError,
  createPool,
} from '@ashuworld/ledger'
import { loadEnv, type Env } from '../src/config.js'
import { buildServer } from '../src/server.js'

const cfg: GameConfig = {
  version: 'test',
  actions: {
    'twitch.follow': { amount: 50, provider: 'twitch' },
    'discord.member': { amount: 75, provider: 'discord' },
  },
  levels: [
    { level: 0, minXp: 0 },
    { level: 1, minXp: 100 },
    { level: 2, minXp: 300 },
  ],
}

function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL']
  if (url === undefined || url.trim() === '') {
    throw new Error(
      'TEST_DATABASE_URL is not set. The api tests hit a real Postgres, so export it before starting vitest: TEST_DATABASE_URL=postgres://ashu:ashu@localhost:55432/ashu',
    )
  }
  return url
}

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: testDatabaseUrl(),
    SESSION_COOKIE_NAME: 'ashuworld_session',
    COOKIE_SECURE: false,
    ALLOW_DEV_LOGIN: false,
    PUBLIC_BASE_URL: 'http://localhost:3000',
    PORT: 3000,
    ...overrides,
  }
}

let pool: Pool

beforeAll(() => {
  pool = createPool(testDatabaseUrl())
})

afterAll(async () => {
  await pool.end()
})

/**
 * Builds a server, runs the assertions and always closes the instance. `app.log` is
 * silenced so the deliberate failures below do not print stacks; a test that checks the
 * logging spies on the same method.
 */
async function withApp(
  run: (app: FastifyInstance) => Promise<void>,
  options: { pool?: Pool } = {},
): Promise<void> {
  const app = buildServer({ pool: options.pool ?? pool, cfg, env: testEnv() })
  app.log.level = 'silent'
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

describe('GET /api/health', () => {
  it('answers ok when the database answers a round trip', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/health' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ ok: true })
    })
  })

  it('answers 503 with the shared error shape when the database is unreachable', async () => {
    const deadPool = createPool(testDatabaseUrl())
    await deadPool.end()

    await withApp(
      async (app) => {
        const res = await app.inject({ method: 'GET', url: '/api/health' })
        expect(res.statusCode).toBe(503)
        expect(res.json()).toEqual({
          error: {
            code: 'database_unavailable',
            message: 'the database did not answer a health check',
          },
        })
      },
      { pool: deadPool },
    )
  })
})

describe('loadEnv', () => {
  const required = {
    DATABASE_URL: 'postgres://ashu:ashu@localhost:5432/ashu',
    PUBLIC_BASE_URL: 'https://ashu.example',
  }

  it('refuses to start without DATABASE_URL', () => {
    expect(() => loadEnv({ PUBLIC_BASE_URL: 'https://ashu.example' })).toThrow(/DATABASE_URL/)
  })

  it('refuses to start without PUBLIC_BASE_URL', () => {
    expect(() => loadEnv({ DATABASE_URL: 'postgres://localhost/ashu' })).toThrow(/PUBLIC_BASE_URL/)
  })

  it('treats a blank required variable as missing', () => {
    expect(() => loadEnv({ ...required, DATABASE_URL: '   ' })).toThrow(/DATABASE_URL/)
    expect(() => loadEnv({ ...required, PUBLIC_BASE_URL: '' })).toThrow(/PUBLIC_BASE_URL/)
  })

  it('fills the documented defaults', () => {
    expect(loadEnv(required)).toEqual({
      ...required,
      SESSION_COOKIE_NAME: 'ashuworld_session',
      COOKIE_SECURE: false,
      ALLOW_DEV_LOGIN: false,
      PORT: 3000,
    })
  })

  it('reads every override as its real type', () => {
    expect(
      loadEnv({
        ...required,
        SESSION_COOKIE_NAME: 'ashu_dev',
        COOKIE_SECURE: 'true',
        ALLOW_DEV_LOGIN: 'TRUE',
        PORT: '8080',
      }),
    ).toEqual({
      ...required,
      SESSION_COOKIE_NAME: 'ashu_dev',
      COOKIE_SECURE: true,
      ALLOW_DEV_LOGIN: true,
      PORT: 8080,
    })
  })

  it('accepts an explicit false, and blank optional values fall back to defaults', () => {
    expect(
      loadEnv({
        ...required,
        COOKIE_SECURE: 'false',
        ALLOW_DEV_LOGIN: 'false',
        SESSION_COOKIE_NAME: ' ',
        PORT: '',
      }),
    ).toMatchObject({
      SESSION_COOKIE_NAME: 'ashuworld_session',
      COOKIE_SECURE: false,
      ALLOW_DEV_LOGIN: false,
      PORT: 3000,
    })
  })

  it('names the variable when a boolean or port is not usable', () => {
    expect(() => loadEnv({ ...required, COOKIE_SECURE: 'yes' })).toThrow(/COOKIE_SECURE/)
    expect(() => loadEnv({ ...required, ALLOW_DEV_LOGIN: '1' })).toThrow(/ALLOW_DEV_LOGIN/)
    expect(() => loadEnv({ ...required, PORT: 'eighty' })).toThrow(/PORT/)
    expect(() => loadEnv({ ...required, PORT: '0' })).toThrow(/PORT/)
    expect(() => loadEnv({ ...required, PORT: '70000' })).toThrow(/PORT/)
    expect(() => loadEnv({ ...required, PORT: '30.5' })).toThrow(/PORT/)
  })
})

describe('error shape', () => {
  it('maps a ledger validation error to 400 with its code and message', async () => {
    await withApp(async (app) => {
      app.get('/test/penalty', async () => {
        throw new PenaltyError('invalid_amount', 'a punishment must lower the balance')
      })

      const res = await app.inject({ method: 'GET', url: '/test/penalty' })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        error: { code: 'invalid_amount', message: 'a punishment must lower the balance' },
      })
    })
  })

  it('maps a broken deployment config to 500 invalid_config', async () => {
    await withApp(async (app) => {
      app.get('/test/config', async () => {
        throw new ConfigError('action "twitch.follow" must have a positive integer amount')
      })

      const res = await app.inject({ method: 'GET', url: '/test/config' })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({
        error: {
          code: 'invalid_config',
          message: 'action "twitch.follow" must have a positive integer amount',
        },
      })
    })
  })

  it('maps an award conflict to 500 award_conflict', async () => {
    await withApp(async (app) => {
      app.get('/test/award', async () => {
        throw new AwardConflictError({
          provider: 'twitch',
          actionKey: 'twitch.follow',
          idempotencyKey: 'event-1',
        })
      })

      const res = await app.inject({ method: 'GET', url: '/test/award' })
      expect(res.statusCode).toBe(500)
      const body = res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('award_conflict')
      expect(body.error.message).toContain('award conflict')
    })
  })

  it('maps a taken handle to 409 handle_taken', async () => {
    await withApp(async (app) => {
      app.get('/test/handle', async () => {
        throw new HandleTakenError('ashu')
      })

      const res = await app.inject({ method: 'GET', url: '/test/handle' })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error: { code: 'handle_taken', message: 'handle "ashu" is already taken' },
      })
    })
  })

  it('maps a Fastify validation failure to 400 invalid_request', async () => {
    await withApp(async (app) => {
      app.get<{ Querystring: { limit: number } }>(
        '/test/validated',
        {
          schema: {
            querystring: {
              type: 'object',
              required: ['limit'],
              properties: { limit: { type: 'integer' } },
            },
          },
        },
        async (request) => ({ limit: request.query.limit }),
      )

      const res = await app.inject({ method: 'GET', url: '/test/validated?limit=abc' })
      expect(res.statusCode).toBe(400)
      const body = res.json() as { error: { code: string; message: string } }
      expect(body.error.code).toBe('invalid_request')
      expect(body.error.message).toContain('limit')
    })
  })

  it('hides and logs an unknown error', async () => {
    await withApp(async (app) => {
      const logged = vi.spyOn(app.log, 'error')
      app.get('/test/boom', async () => {
        throw new Error('secret detail')
      })

      const res = await app.inject({ method: 'GET', url: '/test/boom' })
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({
        error: { code: 'internal', message: 'the server could not complete the request' },
      })
      expect(res.body).not.toContain('secret detail')
      expect(logged).toHaveBeenCalled()
      expect(logged.mock.calls.some((call) => String(call[1]).includes('unhandled'))).toBe(true)
    })
  })

  it('answers an unknown route with 404 not_found in the same shape', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/nope' })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({
        error: {
          code: 'not_found',
          message: 'no route matches GET /api/nope',
        },
      })
    })
  })
})

describe('plugins', () => {
  it('registers the cookie plugin for the sessions that come next', async () => {
    await withApp(async (app) => {
      await app.ready()
      expect(app.hasPlugin('@fastify/cookie')).toBe(true)
    })
  })
})
