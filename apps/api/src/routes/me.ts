import type { FastifyInstance } from 'fastify'
import { getStanding, withTransaction, type Queryable } from '@ashuworld/ledger'
import {
  authenticatedFanId,
  clearSessionCookie,
  destroySession,
  requireFan,
  type AuthDeps,
} from '../auth/session.js'

/** One provider account currently attached to the fan. */
export interface FanIdentity {
  id: string
  provider: string
  displayHandle: string
  /** Always true here: the query selects attached identities, so the field is explicit. */
  linked: boolean
}

/** What `GET /api/me` answers: the account, its live standing and its identities. */
export interface FanProfile {
  id: string
  handle: string
  displayName: string
  balance: number
  peakXp: number
  level: number
  identities: FanIdentity[]
}

interface FanRow {
  id: string
  handle: string
  display_name: string
}

interface IdentityRow {
  id: string
  provider: string
  display_handle: string
}

/**
 * Builds the profile from the ledger.
 *
 * The fan row is read first so a session pointing at an account that no longer exists
 * fails with a named error rather than a fake balance. It cannot happen through the
 * schema — `sessions.fan_id` cascades from `fans` — but the read must not pretend a fan
 * exists if it does not.
 *
 * A detached identity has `fan_id` null, so it is not part of this fan's list at all.
 * That is the whole account model: the list is what the fan holds now, and there is no
 * detached history to show.
 *
 * All three reads share the caller's transaction, so the standing and the identity list
 * are one snapshot rather than three moments.
 */
export async function readFanProfile(tx: Queryable, fanId: string): Promise<FanProfile> {
  const { rows } = await tx.query<FanRow>(
    `select id, handle, display_name
       from fans
      where id = $1`,
    [fanId],
  )
  const fan = rows[0]
  if (fan === undefined) {
    throw new Error(`readFanProfile: no fans row for ${fanId}`)
  }

  const standing = await getStanding(tx, fanId)

  const identities = await tx.query<IdentityRow>(
    `select id, provider, display_handle
       from provider_identities
      where fan_id = $1
      order by provider, display_handle, id`,
    [fanId],
  )

  return {
    id: fan.id,
    handle: fan.handle,
    displayName: fan.display_name,
    balance: standing.balance,
    peakXp: standing.peakXp,
    level: standing.level,
    identities: identities.rows.map((identity) => ({
      id: identity.id,
      provider: identity.provider,
      displayHandle: identity.display_handle,
      linked: true,
    })),
  }
}

/**
 * The signed-in surface: who the caller is, and signing out.
 *
 * `GET /api/me` is the first route behind `requireFan`; the preHandler is the only place
 * that turns a cookie into a fan, so a handler cannot accidentally trust a caller-supplied
 * id.
 *
 * `POST /auth/logout` deliberately has no preHandler. A sign-out must work for a visitor
 * whose session is already expired, already destroyed, or never existed: they get the
 * same 204 and the same cleared cookie, and no error tells them whether the session was
 * real. The row is only deleted when a cookie names one, and an unknown id deletes
 * nothing.
 */
export function registerMeRoutes(app: FastifyInstance, deps: AuthDeps): void {
  app.get('/api/me', { preHandler: requireFan(deps) }, async (request) => {
    const fanId = authenticatedFanId(request)
    return withTransaction(deps.pool, (tx) => readFanProfile(tx, fanId))
  })

  app.post('/auth/logout', async (request, reply) => {
    const sessionId = request.cookies[deps.env.SESSION_COOKIE_NAME]
    if (sessionId !== undefined && sessionId !== '') {
      await withTransaction(deps.pool, (tx) => destroySession(tx, sessionId))
    }
    clearSessionCookie(reply, deps.env)
    return reply.code(204).send()
  })
}
