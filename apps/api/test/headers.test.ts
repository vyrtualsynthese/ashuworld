import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { GameConfig } from '@ashuworld/gameconfig'
import { createPool } from '@ashuworld/ledger'
import { buildServer } from '../src/server.js'
import type { Env } from '../src/config.js'

const cfg: GameConfig = {
  version: 'test',
  actions: { 'twitch.follow': { amount: 50, provider: 'twitch' } },
  levels: [{ level: 0, minXp: 0 }],
  beyond: { step: 1600, factor: 2 },
}

function testDatabaseUrl(): string {
  const url = process.env['TEST_DATABASE_URL']
  if (url === undefined || url.trim() === '') {
    throw new Error('TEST_DATABASE_URL is not set')
  }
  return url
}

function testEnv(): Env {
  return {
    DATABASE_URL: testDatabaseUrl(),
    SESSION_COOKIE_NAME: 'ashuworld_session',
    COOKIE_SECURE: false,
    ALLOW_DEV_LOGIN: false,
    TRUST_PROXY: false,
    PUBLIC_BASE_URL: 'http://localhost:3000',
    ERASURE_PEPPER: 'test-pepper',
    PORT: 3000,
    RATE_LIMIT_ENABLED: false,
    RATE_LIMIT_WINDOW_MS: 60_000,
    RATE_LIMIT_PUBLIC_MAX: 120,
    RATE_LIMIT_AUTH_MAX: 20,
    RATE_LIMIT_WRITE_MAX: 10,
  }
}

let pool: Pool
beforeAll(() => {
  pool = createPool(testDatabaseUrl())
})
afterAll(async () => {
  await pool.end()
})

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = buildServer({ pool, cfg, env: testEnv() })
  app.log.level = 'silent'
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

describe('security headers', () => {
  it('sets a deny-all CSP and the fixed headers on representative routes', async () => {
    await withApp(async (app) => {
      for (const url of ['/api/health', '/api/public/game']) {
        const res = await app.inject({ method: 'GET', url })
        expect(res.headers['content-security-policy']).toContain("default-src 'none'")
        expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
        expect(res.headers['content-security-policy']).toContain("base-uri 'none'")
        expect(res.headers['content-security-policy']).toContain("form-action 'none'")
        expect(res.headers['x-content-type-options']).toBe('nosniff')
        expect(res.headers['referrer-policy']).toBe('no-referrer')
        expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
        expect(res.headers['cross-origin-resource-policy']).toBe('same-origin')
        expect(res.headers['strict-transport-security']).toBe(
          'max-age=31536000; includeSubDomains',
        )
        expect(res.headers['x-powered-by']).toBeUndefined()
      }
    })
  })
})
