import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GameConfig } from '@ashuworld/gameconfig'
import {
  awardOnce,
  createFan,
  ensureIdentity,
  linkIdentity,
  withTransaction,
} from '@ashuworld/ledger'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import type { Env } from '../src/config.js'
import { buildServer } from '../src/server.js'
import { createSession } from '../src/auth/session.js'

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
    ERASURE_PEPPER: 'test-pepper',
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

async function seedFan(handle = 'ashu', displayName = 'Ashu'): Promise<string> {
  const { id } = await withTransaction(db.pool, (tx) => createFan(tx, { handle, displayName }))
  return id
}

async function seedSession(fanId: string): Promise<string> {
  return withTransaction(db.pool, (tx) => createSession(tx, fanId))
}

const ACTION_KEYS: Record<'twitch' | 'discord', string> = {
  twitch: 'twitch.follow',
  discord: 'discord.member',
}

interface SeedIdentityOptions {
  provider?: 'twitch' | 'discord'
  displayHandle?: string
  /** When set, one earn lands on the identity. */
  earn?: { amount: number; idempotencyKey: string }
}

/** Attaches an identity to the fan, optionally with a single earn on it. */
async function seedIdentity(fanId: string, options: SeedIdentityOptions = {}): Promise<string> {
  const provider = options.provider ?? 'twitch'
  const displayHandle =
    options.displayHandle ?? (provider === 'twitch' ? 'ashu_tv' : 'ashu_discord')

  return withTransaction(db.pool, async (tx) => {
    const identity = await ensureIdentity(tx, {
      provider,
      externalId: `${provider}:${displayHandle}`,
      displayHandle,
      displayName: displayHandle,
    })
    const linked = await linkIdentity(tx, { fanId, identityId: identity.id, cfg })
    if (!linked.ok) throw new Error(`seeding failed: link refused with ${linked.reason}`)

    if (options.earn !== undefined) {
      const awarded = await awardOnce(tx, {
        identityId: identity.id,
        provider,
        actionKey: ACTION_KEYS[provider],
        amount: options.earn.amount,
        idempotencyKey: options.earn.idempotencyKey,
        cfg,
      })
      if (!awarded.awarded) throw new Error('seeding failed: the earn was not paid')
    }
    return identity.id
  })
}

function cookieHeader(sessionId: string): { cookie: string } {
  return { cookie: `${COOKIE}=${sessionId}` }
}

interface IdentityRow {
  fan_id: string | null
  linked_at: Date | null
}

async function identityRow(identityId: string): Promise<IdentityRow> {
  const { rows } = await db.pool.query<IdentityRow>(
    'select fan_id, linked_at from provider_identities where id = $1',
    [identityId],
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`no provider_identities row for ${identityId}`)
  return row
}

async function liveEarnCount(identityId: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(
    `select count(*)::text as n
       from xp_entries
      where identity_id = $1 and kind = 'earn' and forfeited_at is null`,
    [identityId],
  )
  return Number(rows[0]?.n ?? '0')
}

async function detachCount(): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(
    `select count(*)::text as n from audit_log where kind = 'detach'`,
  )
  return Number(rows[0]?.n ?? '0')
}

describe('POST /api/me/identities/:identityId/detach', () => {
  it('detaches and reports the forfeit while keeping the level', async () => {
    const fanId = await seedFan()
    const detached = await seedIdentity(fanId, {
      provider: 'twitch',
      displayHandle: 'ashu_tv',
      earn: { amount: 150, idempotencyKey: 'evt-twitch' },
    })
    const kept = await seedIdentity(fanId, {
      provider: 'discord',
      displayHandle: 'ashu_discord',
      earn: { amount: 75, idempotencyKey: 'evt-discord' },
    })
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/identities/${detached}/detach`,
        headers: cookieHeader(sessionId),
      })

      expect(res.statusCode).toBe(200)
      // 225 xp was the peak before the detach, so level 1 survives the forfeit even
      // though the balance drops to the remaining identity's 75.
      expect(res.json()).toEqual({
        forfeitedEntries: 1,
        balance: 75,
        peakXp: 225,
        level: 1,
      })

      const row = await identityRow(detached)
      expect(row.fan_id).toBeNull()
      expect(row.linked_at).toBeNull()
      expect(await liveEarnCount(detached)).toBe(0)
      // The other identity is untouched: still attached, still earning.
      const keptRow = await identityRow(kept)
      expect(keptRow.fan_id).toBe(fanId)
      expect(await liveEarnCount(kept)).toBe(1)
      expect(await detachCount()).toBe(1)

      const listed = await app.inject({
        method: 'GET',
        url: '/api/me/identities',
        headers: cookieHeader(sessionId),
      })
      expect(listed.json()).toEqual([
        { id: kept, provider: 'discord', displayHandle: 'ashu_discord', linked: true },
      ])
    })
  })

  it('reports the balance after the forfeit when the detached identity held every earn', async () => {
    const fanId = await seedFan()
    const onlyEarner = await seedIdentity(fanId, {
      provider: 'twitch',
      displayHandle: 'ashu_tv',
      earn: { amount: 150, idempotencyKey: 'evt-all' },
    })
    await seedIdentity(fanId, { provider: 'discord', displayHandle: 'ashu_discord' })
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/identities/${onlyEarner}/detach`,
        headers: cookieHeader(sessionId),
      })

      // A standing read taken before the detach would still say 150 here. The response
      // is zero because the read happens after the forfeit, in the same transaction.
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        forfeitedEntries: 1,
        balance: 0,
        peakXp: 150,
        level: 1,
      })

      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(sessionId),
      })
      expect(me.json()).toMatchObject({ balance: 0, peakXp: 150, level: 1 })
    })
  })

  it('refuses to detach the only identity with 409 last_identity', async () => {
    const fanId = await seedFan()
    const identityId = await seedIdentity(fanId, {
      earn: { amount: 150, idempotencyKey: 'evt-last' },
    })
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/identities/${identityId}/detach`,
        headers: cookieHeader(sessionId),
      })

      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({
        error: {
          code: 'last_identity',
          message: 'an account must keep at least one identity; add another before detaching this one',
        },
      })

      const row = await identityRow(identityId)
      expect(row.fan_id).toBe(fanId)
      expect(row.linked_at).not.toBeNull()
      expect(await liveEarnCount(identityId)).toBe(1)
      expect(await detachCount()).toBe(0)

      const me = await app.inject({
        method: 'GET',
        url: '/api/me',
        headers: cookieHeader(sessionId),
      })
      expect(me.json()).toMatchObject({ balance: 150 })
    })
  })

  it('rejects an unauthenticated detach', async () => {
    const fanId = await seedFan()
    const identityId = await seedIdentity(fanId)
    await seedIdentity(fanId, { provider: 'discord', displayHandle: 'ashu_discord' })

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/identities/${identityId}/detach`,
      })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({
        error: { code: 'unauthenticated', message: 'sign in to continue' },
      })
      expect((await identityRow(identityId)).fan_id).toBe(fanId)
    })
  })

  it('returns 404 when the identity id belongs to another fan, exactly as for a missing id', async () => {
    const fanA = await seedFan('ashu', 'Ashu')
    const fanB = await seedFan('bob', 'Bob')
    await seedIdentity(fanA, { provider: 'twitch', displayHandle: 'ashu_tv' })
    const victimIdentity = await seedIdentity(fanB, {
      provider: 'twitch',
      displayHandle: 'bob_tv',
      earn: { amount: 350, idempotencyKey: 'evt-bob' },
    })
    await seedIdentity(fanB, { provider: 'discord', displayHandle: 'bob_discord' })
    const sessionA = await seedSession(fanA)

    await withApp(async (app) => {
      const foreign = await app.inject({
        method: 'POST',
        url: `/api/me/identities/${victimIdentity}/detach`,
        headers: cookieHeader(sessionA),
      })
      const missing = await app.inject({
        method: 'POST',
        url: `/api/me/identities/${randomUUID()}/detach`,
        headers: cookieHeader(sessionA),
      })

      expect(foreign.statusCode).toBe(404)
      expect(missing.statusCode).toBe(404)
      // Same status and same body: the answer cannot be used to tell an id that exists
      // on another account from one that exists nowhere. A 403 here would be an
      // existence oracle.
      expect(foreign.json()).toEqual(NOT_FOUND)
      expect(foreign.body).toBe(missing.body)
      expect(foreign.headers['content-type']).toBe(missing.headers['content-type'])

      // And the probe changed nothing for the victim.
      const victimRow = await identityRow(victimIdentity)
      expect(victimRow.fan_id).toBe(fanB)
      expect(await liveEarnCount(victimIdentity)).toBe(1)
      expect(await detachCount()).toBe(0)
    })
  })

  it('answers 404 the same way for an id that is not a uuid', async () => {
    const fanId = await seedFan()
    await seedIdentity(fanId)
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/identities/not-a-uuid/detach',
        headers: cookieHeader(sessionId),
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual(NOT_FOUND)
    })
  })

  it('answers 404 when the identity was already detached', async () => {
    const fanId = await seedFan()
    const identityId = await seedIdentity(fanId, { provider: 'twitch' })
    await seedIdentity(fanId, { provider: 'discord', displayHandle: 'ashu_discord' })
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      const first = await app.inject({
        method: 'POST',
        url: `/api/me/identities/${identityId}/detach`,
        headers: cookieHeader(sessionId),
      })
      expect(first.statusCode).toBe(200)

      const second = await app.inject({
        method: 'POST',
        url: `/api/me/identities/${identityId}/detach`,
        headers: cookieHeader(sessionId),
      })
      expect(second.statusCode).toBe(404)
      expect(second.json()).toEqual(NOT_FOUND)
    })
  })

  it('answers 409 not_attached when the identity is detached while the request waits', async () => {
    const fanId = await seedFan()
    const identityId = await seedIdentity(fanId, { provider: 'twitch' })
    await seedIdentity(fanId, { provider: 'discord', displayHandle: 'ashu_discord' })
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      // A second connection holds the identity row, so the detach passes its own scoped
      // read and then waits inside `detachIdentity`. Releasing the lock after another
      // writer has unlinked the identity is the one way `not_attached` is reachable.
      const blocker = await db.pool.connect()
      try {
        await blocker.query('begin')
        await blocker.query('select id from provider_identities where id = $1 for update', [
          identityId,
        ])

        const pending = app.inject({
          method: 'POST',
          url: `/api/me/identities/${identityId}/detach`,
          headers: cookieHeader(sessionId),
        })

        await waitForBlockedDetach()

        await blocker.query(
          'update provider_identities set fan_id = null, linked_at = null where id = $1',
          [identityId],
        )
        await blocker.query('commit')

        const res = await pending
        expect(res.statusCode).toBe(409)
        expect(res.json()).toEqual({
          error: {
            code: 'not_attached',
            message: 'that identity is not attached to your account',
          },
        })
      } finally {
        await blocker.query('rollback').catch(() => undefined)
        blocker.release()
      }
    })
  })
})

describe('GET /api/me/identities', () => {
  it('lists only the caller identities, in provider order, with linked state', async () => {
    const fanA = await seedFan('ashu', 'Ashu')
    const fanB = await seedFan('bob', 'Bob')
    const twitch = await seedIdentity(fanA, { provider: 'twitch', displayHandle: 'zeta_tv' })
    const discord = await seedIdentity(fanA, {
      provider: 'discord',
      displayHandle: 'alpha_discord',
    })
    const otherFanIdentity = await seedIdentity(fanB, {
      provider: 'twitch',
      displayHandle: 'bob_tv',
    })
    const sessionA = await seedSession(fanA)
    const sessionB = await seedSession(fanB)

    await withApp(async (app) => {
      const asA = await app.inject({
        method: 'GET',
        url: '/api/me/identities',
        headers: cookieHeader(sessionA),
      })

      expect(asA.statusCode).toBe(200)
      expect(asA.json()).toEqual([
        { id: discord, provider: 'discord', displayHandle: 'alpha_discord', linked: true },
        { id: twitch, provider: 'twitch', displayHandle: 'zeta_tv', linked: true },
      ])
      expect(asA.body).not.toContain(otherFanIdentity)
      expect(asA.body).not.toContain('bob_tv')

      const asB = await app.inject({
        method: 'GET',
        url: '/api/me/identities',
        headers: cookieHeader(sessionB),
      })
      expect(asB.statusCode).toBe(200)
      expect(asB.json()).toEqual([
        { id: otherFanIdentity, provider: 'twitch', displayHandle: 'bob_tv', linked: true },
      ])
      expect(asB.body).not.toContain(twitch)
      expect(asB.body).not.toContain(discord)
    })
  })

  it('lists nothing for a signed-in fan with no identity', async () => {
    const fanId = await seedFan()
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/me/identities',
        headers: cookieHeader(sessionId),
      })

      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([])
    })
  })

  it('rejects an unauthenticated listing', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/me/identities' })

      expect(res.statusCode).toBe(401)
      expect(res.json()).toEqual({
        error: { code: 'unauthenticated', message: 'sign in to continue' },
      })
    })
  })
})

describe('no attach endpoint', () => {
  it('registers no non-GET route under /api/me/identities except the detach', async () => {
    // A single 404 for `…/reattach` proves one URL, not the invariant: a later
    // `POST …/:id/attach`, `PUT …/:id`, or `POST …/link` would pass every other test.
    // The registered route table is the only place the whole surface can be seen.
    await withApp(async (app) => {
      await app.ready()
      const writes = registeredRoutes(app)
        .filter((route) => route.path === '/api/me/identities' || route.path.startsWith('/api/me/identities/'))
        .filter((route) => route.method !== 'GET' && route.method !== 'HEAD')

      expect(writes).toEqual([
        { method: 'POST', path: '/api/me/identities/:identityId/detach' },
      ])
    })
  })

  it('answers 404 for a reattach request, even with a live session', async () => {
    const fanId = await seedFan()
    const identityId = await seedIdentity(fanId)
    const sessionId = await seedSession(fanId)

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/identities/${identityId}/reattach`,
        headers: cookieHeader(sessionId),
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual(NOT_FOUND)
      // Attaching or re-attaching an identity by id must never be possible: only a
      // provider callback can prove who controls the account.
      expect((await identityRow(identityId)).fan_id).toBe(fanId)
    })
  })

  it('answers 404 for a reattach request naming another fan identity', async () => {
    const fanA = await seedFan('ashu', 'Ashu')
    const fanB = await seedFan('bob', 'Bob')
    await seedIdentity(fanA)
    const victimIdentity = await seedIdentity(fanB, {
      provider: 'twitch',
      displayHandle: 'bob_tv',
    })
    const sessionA = await seedSession(fanA)

    await withApp(async (app) => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/me/identities/${victimIdentity}/reattach`,
        headers: cookieHeader(sessionA),
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual(NOT_FOUND)
    })
  })
})

describe('the public route table', () => {
  // The public surface is a promise: every path here is readable by anyone, cached by a
  // shared CDN, and ignored by the session. A new route under `/api/public` is therefore
  // a security decision, not an implementation detail, so the whole set is pinned and a
  // route added without thought fails the suite.
  it('registers exactly these public GET routes', async () => {
    await withApp(async (app) => {
      await app.ready()
      const gets = registeredRoutes(app)
        .filter((route) => route.path.startsWith('/api/public/'))
        .filter((route) => route.method === 'GET')
        .map((route) => route.path)
        .sort()

      expect(gets).toEqual([
        '/api/public/fans/:handle',
        '/api/public/game',
        '/api/public/ladder',
        '/api/public/providers',
      ])
    })
  })

  it('registers nothing but reads under /api/public', async () => {
    await withApp(async (app) => {
      await app.ready()
      const writes = registeredRoutes(app)
        .filter((route) => route.path.startsWith('/api/public/'))
        .filter((route) => route.method !== 'GET' && route.method !== 'HEAD')

      expect(writes).toEqual([])
    })
  })
})

interface RegisteredRoute {
  method: string
  path: string
}

/**
 * The registered route table, read from Fastify's documented `printRoutes` output.
 *
 * `commonPrefix: false` prints one line per handler, indented one level per path
 * fragment; joining the fragments by depth reconstructs the full path. A line this
 * cannot parse throws rather than being skipped, so a formatting change fails the test
 * instead of quietly shrinking the set it asserts over.
 */
function registeredRoutes(app: FastifyInstance): RegisteredRoute[] {
  const tree = app.printRoutes({ commonPrefix: false })
  const routes: RegisteredRoute[] = []
  const fragments: string[] = []

  for (const line of tree.split('\n')) {
    if (line.trim() === '') continue
    const match = /^((?:[│ ] {3})*)[├└]── (\S+) \(([^)]+)\)$/.exec(line)
    if (match === null) throw new Error(`unparsed route table line: ${JSON.stringify(line)}`)

    const depth = (match[1] ?? '').length / 4
    fragments[depth] = match[2] ?? ''
    fragments.length = depth + 1
    const path = fragments.join('')
    for (const method of (match[3] ?? '').split(', ')) routes.push({ method, path })
  }

  return routes
}

/**
 * Waits until the detach request's backend is blocked on a lock. Polling the database is
 * what makes the race above deterministic: sleeping for a guessed duration would let the
 * test commit its competing write before the request had even taken its snapshot.
 *
 * The match is the detach statement itself, whitespace-normalised, scoped to this
 * database. A looser `from provider_identities … for update` would also match
 * `linkIdentity`'s `select fan_id, provider … for update` running in a parallel test
 * project, and a false positive would release the blocker too early. The deadline is a
 * few seconds rather than an open loop: a request that never blocks means the race is not
 * being exercised, and the test must say so instead of hanging.
 */
async function waitForBlockedDetach(): Promise<void> {
  const detachSelect = 'select fan_id from provider_identities where id = $1 for update'
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const { rows } = await db.pool.query<{ n: number }>(
      `select count(*)::int as n
         from pg_stat_activity
        where wait_event_type = 'Lock'
          and datname = current_database()
          and regexp_replace(query, '\\s+', ' ', 'g') = $1
          and pid <> pg_backend_pid()`,
      [detachSelect],
    )
    if ((rows[0]?.n ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('the detach request never blocked on the identity row within 5 seconds')
}
