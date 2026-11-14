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
import { HEALTH_TIMEOUT_MS } from '../src/routes/health.js'

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
  beyond: { step: 1600, factor: 2 },
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
    TRUST_PROXY: false,
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
      expect(res.headers['content-type']).toContain('application/json')
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
        expect(res.headers['content-type']).toContain('application/json')
      },
      { pool: deadPool },
    )
  })

  it('answers 503 within the timeout when the database never answers at all', async () => {
    // A pool whose connection accepts every statement and then never resolves: the
    // shape of a database that holds the TCP connection but stops answering. Without a
    // bound this probe hangs forever and each request leaks a client.
    const never = new Promise<never>(() => undefined)
    const hangingPool = {
      connect: async () => ({ query: () => never, release: () => undefined }),
      end: async () => undefined,
    } as unknown as Pool

    const started = Date.now()
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
      { pool: hangingPool },
    )
    expect(Date.now() - started).toBeLessThan(HEALTH_TIMEOUT_MS + 1_500)
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

  it('fills the documented defaults, deriving Secure from an https base URL', () => {
    expect(loadEnv(required)).toEqual({
      ...required,
      SESSION_COOKIE_NAME: 'ashuworld_session',
      COOKIE_SECURE: true,
      ALLOW_DEV_LOGIN: false,
      TRUST_PROXY: false,
      PORT: 3000,
      LOG_LEVEL: 'info',
    })
  })

  it('leaves Secure off when the public base URL is plain http', () => {
    expect(loadEnv({ ...required, PUBLIC_BASE_URL: 'http://localhost:3000' })).toMatchObject({
      COOKIE_SECURE: false,
    })
  })

  it('defaults the log level to info and accepts an explicit one', () => {
    expect(loadEnv(required)).toMatchObject({ LOG_LEVEL: 'info' })
    expect(loadEnv({ ...required, LOG_LEVEL: 'debug' })).toMatchObject({ LOG_LEVEL: 'debug' })
    expect(loadEnv({ ...required, LOG_LEVEL: 'DEBUG' })).toMatchObject({ LOG_LEVEL: 'debug' })
  })

  it('rejects an unknown log level instead of silently logging at info', () => {
    expect(() => loadEnv({ ...required, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/)
  })

  it('recognises https whatever its case', () => {
    expect(loadEnv({ ...required, PUBLIC_BASE_URL: 'HTTPS://ashu.example' })).toMatchObject({
      COOKIE_SECURE: true,
    })
  })

  it('lets an explicit COOKIE_SECURE=false override an https base URL', () => {
    expect(loadEnv({ ...required, COOKIE_SECURE: 'false' })).toMatchObject({
      COOKIE_SECURE: false,
    })
  })

  it('lets an explicit COOKIE_SECURE=true win over a plain-http base URL', () => {
    expect(
      loadEnv({ ...required, PUBLIC_BASE_URL: 'http://localhost:3000', COOKIE_SECURE: 'true' }),
    ).toMatchObject({ COOKIE_SECURE: true })
  })

  it('reads every override as its real type', () => {
    expect(
      loadEnv({
        ...required,
        SESSION_COOKIE_NAME: 'ashu_dev',
        COOKIE_SECURE: 'true',
        ALLOW_DEV_LOGIN: 'TRUE',
        TRUST_PROXY: 'true',
        PORT: '8080',
        LOG_LEVEL: 'debug',
      }),
    ).toEqual({
      ...required,
      SESSION_COOKIE_NAME: 'ashu_dev',
      COOKIE_SECURE: true,
      ALLOW_DEV_LOGIN: true,
      TRUST_PROXY: true,
      PORT: 8080,
      LOG_LEVEL: 'debug',
    })
  })

  it('defaults TRUST_PROXY off and rejects a value that is not a boolean', () => {
    expect(loadEnv(required)).toMatchObject({ TRUST_PROXY: false })
    expect(loadEnv({ ...required, TRUST_PROXY: 'false' })).toMatchObject({ TRUST_PROXY: false })
    expect(loadEnv({ ...required, TRUST_PROXY: ' TRUE ' })).toMatchObject({ TRUST_PROXY: true })
    expect(loadEnv({ ...required, TRUST_PROXY: ' ' })).toMatchObject({ TRUST_PROXY: false })
    expect(() => loadEnv({ ...required, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/)
  })

  it('trims required values like the other readers do', () => {
    expect(
      loadEnv({
        DATABASE_URL: '  postgres://ashu:ashu@localhost:5432/ashu  ',
        PUBLIC_BASE_URL: ' https://ashu.example ',
      }),
    ).toMatchObject({
      DATABASE_URL: 'postgres://ashu:ashu@localhost:5432/ashu',
      PUBLIC_BASE_URL: 'https://ashu.example',
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
      expect(res.headers['content-type']).toContain('application/json')
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

  it('keeps a malformed JSON body a 400', async () => {
    await withApp(async (app) => {
      app.post('/test/echo', async () => ({ ok: true }))

      const res = await app.inject({
        method: 'POST',
        url: '/test/echo',
        headers: { 'content-type': 'application/json' },
        payload: '{"broken":',
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        error: { code: 'bad_request', message: 'the request could not be understood' },
      })
    })
  })

  it('keeps an oversized body a 413', async () => {
    await withApp(async (app) => {
      app.post('/test/echo', async () => ({ ok: true }))

      const res = await app.inject({
        method: 'POST',
        url: '/test/echo',
        headers: { 'content-type': 'application/json' },
        payload: 'x'.repeat(1_048_577),
      })
      expect(res.statusCode).toBe(413)
      expect(res.json()).toEqual({
        error: { code: 'payload_too_large', message: 'the request body is too large' },
      })
    })
  })

  it('keeps an unsupported content type a 415', async () => {
    await withApp(async (app) => {
      app.post('/test/echo', async () => ({ ok: true }))

      const res = await app.inject({
        method: 'POST',
        url: '/test/echo',
        headers: { 'content-type': 'application/xml' },
        payload: '<x/>',
      })
      expect(res.statusCode).toBe(415)
      expect(res.json()).toEqual({
        error: {
          code: 'unsupported_media_type',
          message: 'the request content type is not supported',
        },
      })
    })
  })

  it('maps any other client status to that status with a generic message', async () => {
    await withApp(async (app) => {
      app.get('/test/teapot', async () => {
        const error = new Error('I am a teapot')
        ;(error as { statusCode?: number }).statusCode = 418
        throw error
      })

      const res = await app.inject({ method: 'GET', url: '/test/teapot' })
      expect(res.statusCode).toBe(418)
      expect(res.json()).toEqual({
        error: { code: 'client_error', message: 'the request was refused' },
      })
      expect(res.body).not.toContain('teapot')
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
      expect(res.body).not.toContain('stack')
      expect(logged).toHaveBeenCalled()
      expect(logged.mock.calls.some((call) => String(call[1]).includes('unhandled'))).toBe(true)
    })
  })

  it('answers an unknown GET route with a fixed 404 that does not echo the request', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/nope?token=abc' })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({
        error: {
          code: 'not_found',
          message: 'the requested resource does not exist',
        },
      })
      expect(res.body).not.toContain('/api/nope')
      expect(res.body).not.toContain('token')
    })
  })

  it('answers an unknown POST route with the same fixed 404', async () => {
    await withApp(async (app) => {
      const logged = vi.spyOn(app.log, 'info')
      const res = await app.inject({ method: 'POST', url: '/api/nope', payload: {} })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({
        error: {
          code: 'not_found',
          message: 'the requested resource does not exist',
        },
      })
      expect(logged).toHaveBeenCalled()
    })
  })

  it('logs the 404 path without the query string', async () => {
    // A callback URL typed at the wrong path still carries the provider's `code` and the
    // handshake `state`, and both are credentials. The response already refuses to echo
    // the URL; the log line must not keep it either.
    const lines: string[] = []
    const app = buildServer({
      pool,
      cfg,
      env: testEnv(),
      logStream: { write: (line) => lines.push(line) },
    })
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/dev/callbak?code=live-code&state=live-state',
      })
      expect(res.statusCode).toBe(404)

      const requestLines = lines
        .map((line) => JSON.parse(line) as { req?: { method: string; url: string } })
        .filter((entry) => entry.req !== undefined)
      expect(requestLines.length).toBeGreaterThan(0)
      for (const entry of requestLines) {
        expect(entry.req?.url).toBe('/auth/dev/callbak')
        expect(entry.req?.url).not.toContain('?')
      }
      expect(lines.join('\n')).not.toContain('live-code')
      expect(lines.join('\n')).not.toContain('live-state')
    } finally {
      await app.close()
    }
  })

  it('keeps the client address and port on the request log line', async () => {
    // `inject` fakes a socket without a source port, so this one request goes over a
    // real loopback connection: the fields are only meaningful if a real socket fills
    // them in.
    const lines: string[] = []
    const app = buildServer({
      pool,
      cfg,
      env: testEnv(),
      logStream: { write: (line) => lines.push(line) },
    })
    try {
      const base = await app.listen({ port: 0, host: '127.0.0.1' })
      const res = await fetch(`${base}/api/health`)
      expect(res.status).toBe(200)

      const requestLines = lines
        .map(
          (line) =>
            JSON.parse(line) as {
              req?: { method: string; url: string; remoteAddress?: string; remotePort?: number }
            },
        )
        .filter((entry) => entry.req?.url === '/api/health')
      expect(requestLines.length).toBeGreaterThan(0)
      const request = requestLines[0]?.req
      expect(request?.method).toBe('GET')
      expect(typeof request?.remoteAddress).toBe('string')
      expect(request?.remoteAddress).toBe('127.0.0.1')
      expect(typeof request?.remotePort).toBe('number')
      expect(request?.remotePort).toBeGreaterThan(0)
    } finally {
      await app.close()
    }
  })

  it('takes the client address from the forwarding header only when TRUST_PROXY is on', async () => {
    // Behind an ingress, `request.ip` is the proxy unless the deployment trusts the
    // header. Off by default: a caller must not be able to choose the logged address.
    const addressFor = async (trustProxy: boolean): Promise<string | undefined> => {
      const lines: string[] = []
      const app = buildServer({
        pool,
        cfg,
        env: testEnv({ TRUST_PROXY: trustProxy }),
        logStream: { write: (line) => lines.push(line) },
      })
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/health',
          headers: { 'x-forwarded-for': '203.0.113.9' },
        })
        expect(res.statusCode).toBe(200)
        const entries = lines
          .map((line) => JSON.parse(line) as { req?: { url: string; remoteAddress?: string } })
          .filter((entry) => entry.req?.url === '/api/health')
        return entries[0]?.req?.remoteAddress
      } finally {
        await app.close()
      }
    }

    await expect(addressFor(false)).resolves.toBe('127.0.0.1')
    await expect(addressFor(true)).resolves.toBe('203.0.113.9')
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
