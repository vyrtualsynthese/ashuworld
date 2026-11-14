import type { FastifyInstance } from 'fastify'
import { getStanding, withTransaction, type Queryable } from '@ashuworld/ledger'
import {
  authenticatedFanId,
  clearSessionCookie,
  destroySession,
  isSessionId,
  requireFan,
  type AuthDeps,
} from '../auth/session.js'
import { listIdentities, type FanIdentity } from './identities.js'
import { authRateLimit } from '../security/rateLimit.js'

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

/**
 * Builds the profile from the ledger.
 *
 * The fan row is read first so a session pointing at an account that no longer exists
 * fails with a named error rather than a fake balance. It cannot happen through the
 * schema — `sessions.fan_id` cascades from `fans` — but the read must not pretend a fan
 * exists if it does not.
 *
 * The identity list comes from `listIdentities`, the same function behind
 * `GET /api/me/identities`. Two copies of that select and its mapping would let the two
 * endpoints disagree about what is attached, which is exactly the pair a client compares.
 *
 * All the reads share the caller's transaction, so the standing and the identity list are
 * one snapshot rather than separate moments.
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
  const identities = await listIdentities(tx, fanId)

  return {
    id: fan.id,
    handle: fan.handle,
    displayName: fan.display_name,
    balance: standing.balance,
    peakXp: standing.peakXp,
    level: standing.level,
    identities,
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
 *
 * A failed delete must not change that answer. The point of signing out is to make this
 * browser stop presenting the cookie; answering 500 would leave the browser holding a
 * cookie whose server row is still valid. So the failure is logged for the operator and
 * the cookie is cleared anyway. The row stays until it expires or a later cleanup removes
 * it, which is the trade-off: the local session ends even when the database cannot say so.
 */
export function registerMeRoutes(app: FastifyInstance, deps: AuthDeps): void {
  app.get('/api/me', { preHandler: requireFan(deps) }, async (request) => {
    const fanId = authenticatedFanId(request)
    return withTransaction(deps.pool, (tx) => readFanProfile(tx, fanId))
  })

  app.post('/auth/logout', { config: { rateLimit: authRateLimit(deps.env) } }, async (request, reply) => {
    const sessionId = request.cookies[deps.env.SESSION_COOKIE_NAME]
    if (sessionId !== undefined && isSessionId(sessionId)) {
      try {
        await withTransaction(deps.pool, (tx) => destroySession(tx, sessionId))
      } catch (error) {
        // The id is not included in this line: a log that names it hands an operator's
        // log store a live session.
        request.log.error(
          { err: error },
          'logout could not delete the session row; clearing the cookie anyway',
        )
      }
    }
    clearSessionCookie(reply, deps.env)
    return reply.code(204).send()
  })
}
