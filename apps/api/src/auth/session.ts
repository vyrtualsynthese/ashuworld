import { randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'
import { withTransaction, type Queryable } from '@ashuworld/ledger'
import type { Env } from '../config.js'
import { errorBody } from '../errors.js'

/**
 * Server-side sessions, and the cookie that carries one.
 *
 * The id is 32 random bytes and is stored in `sessions.id` exactly as issued: it is
 * unguessable, so hashing it would add a round trip's worth of work without adding
 * anything an attacker cannot already get by reading the database. Every request that
 * presents it is compared by exact match.
 *
 * The value never leaves the cookie. It is not in a response body, not in a log line and
 * not in an error message; the routes that use it send their own bodies without it.
 */

/** 30 days, in seconds: one place for the session lifetime and the cookie's `Max-Age`. */
export const SESSION_TTL_DAYS = 30
export const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60

/** 32 bytes of entropy, which base64url renders as 43 characters. */
const SESSION_ID_BYTES = 32

const COOKIE_PATH = '/'
const UNAUTHENTICATED_MESSAGE = 'sign in to continue'
const SESSION_STORE_MESSAGE = 'the database did not answer the session lookup'

/** The configuration `requireFan` and the cookie helpers need, and nothing else. */
export type SessionConfig = Pick<Env, 'SESSION_COOKIE_NAME' | 'COOKIE_SECURE'>

export interface AuthDeps {
  pool: Pool
  env: SessionConfig
}

/**
 * The attributes every session cookie carries, setting or clearing.
 *
 * `HttpOnly` keeps the value away from scripts, so an XSS bug cannot read a fan's
 * session. `SameSite=Lax` still sends the cookie on a top-level navigation from another
 * site — which is how the login redirect back from a provider arrives — but not on a
 * cross-site form post or fetch. `Secure` is left to `COOKIE_SECURE` because local
 * development and the test suite speak plain HTTP; a deployment that terminates TLS
 * sets it to true, and forgetting that is a deployment mistake visible in the response.
 */
function cookieAttributes(env: SessionConfig): {
  httpOnly: true
  sameSite: 'lax'
  path: string
  secure: boolean
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: COOKIE_PATH,
    secure: env.COOKIE_SECURE,
  }
}

/** Issues a session for `fanId` and returns the opaque id the caller puts in the cookie. */
export async function createSession(tx: Queryable, fanId: string): Promise<string> {
  const id = randomBytes(SESSION_ID_BYTES).toString('base64url')
  await tx.query(
    `insert into sessions (id, fan_id, expires_at)
     values ($1, $2, now() + make_interval(days => $3))`,
    [id, fanId, SESSION_TTL_DAYS],
  )
  return id
}

/**
 * Reads the fan behind a session id, or `null` when the row is missing or expired.
 *
 * Expiry is checked in the select, not in TypeScript, so an expired row can never be
 * mistaken for a live one because the application clock and the database clock disagree.
 * The row itself is left in place: a nightly delete is a separate concern from deciding
 * whether a request is signed in.
 */
export async function readSession(
  tx: Queryable,
  id: string,
): Promise<{ fanId: string } | null> {
  const { rows } = await tx.query<{ fan_id: string }>(
    `select fan_id
       from sessions
      where id = $1 and expires_at > now()`,
    [id],
  )
  const row = rows[0]
  return row === undefined ? null : { fanId: row.fan_id }
}

/** Removes the session. Deleting an id that is not there is a no-op, not an error. */
export async function destroySession(tx: Queryable, id: string): Promise<void> {
  await tx.query('delete from sessions where id = $1', [id])
}

/** Puts the session id in the fan's cookie jar, for the same 30 days the row lives. */
export function setSessionCookie(
  reply: FastifyReply,
  env: SessionConfig,
  sessionId: string,
): void {
  reply.setCookie(env.SESSION_COOKIE_NAME, sessionId, {
    ...cookieAttributes(env),
    maxAge: SESSION_TTL_SECONDS,
  })
}

/**
 * Removes the cookie from the browser. The attributes match the ones it was set with, so
 * a browser that scopes cookies by path and flags finds and deletes the right one.
 */
export function clearSessionCookie(reply: FastifyReply, env: SessionConfig): void {
  reply.clearCookie(env.SESSION_COOKIE_NAME, cookieAttributes(env))
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The fan id `requireFan` proved for this request. Present only on routes that list
     * that preHandler; `authenticatedFanId` turns its absence into a loud failure rather
     * than a query for `undefined`.
     */
    fanId?: string
  }
}

/**
 * The preHandler that authenticates a fan.
 *
 * A factory, not a bare `(request, reply)` handler: the plan's literal signature has no
 * way to receive the pool or the configured cookie name, and reaching for module-level
 * state would make the server untestable and impossible to run twice in one process.
 * Fastify calls hooks with only `request` and `reply`, so the dependencies are bound
 * here and the returned function is what a route registers.
 *
 * It answers instead of throwing: a hook that throws reaches the shared error handler,
 * which reports an internal failure for what is really an ordinary signed-out request.
 * A store that cannot answer is a 503 rather than a 401 — signing every fan out because
 * Postgres hiccuped would be a lie, and a 500 would not say what is broken.
 */
export function requireFan(deps: AuthDeps): preHandlerHookHandler {
  return async (request, reply) => {
    const sessionId = request.cookies[deps.env.SESSION_COOKIE_NAME]
    if (sessionId === undefined || sessionId === '') {
      return reply.code(401).send(errorBody('unauthenticated', UNAUTHENTICATED_MESSAGE))
    }

    let session: { fanId: string } | null
    try {
      session = await withTransaction(deps.pool, (tx) => readSession(tx, sessionId))
    } catch (error) {
      request.log.error({ err: error }, 'session lookup failed: the database did not answer')
      return reply
        .code(503)
        .send(errorBody('database_unavailable', SESSION_STORE_MESSAGE))
    }

    if (session === null) {
      return reply.code(401).send(errorBody('unauthenticated', UNAUTHENTICATED_MESSAGE))
    }

    request.fanId = session.fanId
  }
}

/**
 * The fan id a route behind `requireFan` may rely on.
 *
 * The declared property is optional because every other route shares the same request
 * type. This turns a route that forgot the preHandler into an immediate, named failure
 * instead of a `where id = undefined` query with a confusing answer.
 */
export function authenticatedFanId(request: FastifyRequest): string {
  const fanId = request.fanId
  if (fanId === undefined) {
    throw new Error('requireFan did not run before this handler, so the request has no fan id')
  }
  return fanId
}
