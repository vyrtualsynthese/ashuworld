import { randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
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

/** 32 bytes of entropy, which base64url renders as exactly 43 characters. */
const SESSION_ID_BYTES = 32
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

const COOKIE_PATH = '/'
const UNAUTHENTICATED_MESSAGE = 'sign in to continue'
const SESSION_STORE_MESSAGE = 'the database did not answer the session lookup'

/** The configuration `requireFan` and the cookie helpers need, and nothing else. */
export type SessionConfig = Pick<Env, 'SESSION_COOKIE_NAME' | 'COOKIE_SECURE'>

export interface AuthDeps {
  pool: Pool
  env: Env
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
 * True for a value shaped like an id `createSession` could have issued.
 *
 * Checked before any query. Postgres would happily answer a text lookup for `'abc'`, but
 * a cookie is caller-controlled and there is no reason to hand an arbitrary string to the
 * database on every request: the shape is the cheapest filter, and it keeps a malformed
 * value from costing a connection or reaching a query log.
 */
export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}

/**
 * Reads the fan behind a session id, or `null` when the row is missing or expired.
 *
 * Expiry is checked in the select, not in TypeScript, so an expired row can never be
 * mistaken for a live one because the application clock and the database clock disagree.
 * The row itself is left in place: a nightly delete is a separate concern from deciding
 * whether a request is signed in.
 *
 * A value that is not shaped like a session id is answered as signed out without a query.
 * Repeating the check here as well as in `requireFan` means a future caller that reaches
 * this function directly cannot skip it.
 */
export async function readSession(
  tx: Queryable,
  id: string,
): Promise<{ fanId: string } | null> {
  if (!isSessionId(id)) return null

  const { rows } = await tx.query<{ fan_id: string }>(
    `select fan_id
       from sessions
      where id = $1 and expires_at > now()`,
    [id],
  )
  const row = rows[0]
  return row === undefined ? null : { fanId: row.fan_id }
}

/**
 * The session id the request presents, when it is shaped like one this service could
 * have issued. Answers null for a missing cookie and for anything that is not a session
 * id, so a caller can reject a malformed value before opening a transaction.
 */
export function presentedSessionId(request: FastifyRequest, env: SessionConfig): string | null {
  const id = request.cookies[env.SESSION_COOKIE_NAME]
  if (id === undefined || id === '') return null
  return isSessionId(id) ? id : null
}

/**
 * The fan behind the request's session cookie, or null when there is no live session.
 *
 * `requireFan` and the OAuth callback both need this answer. They reach it differently —
 * the hook answers 401 and the callback decides by handshake purpose — but they agree on
 * what counts as signed in because both go through `readSession` and its expiry check.
 */
export async function sessionFanId(
  tx: Queryable,
  request: FastifyRequest,
  env: SessionConfig,
): Promise<string | null> {
  const id = presentedSessionId(request, env)
  if (id === null) return null
  const session = await readSession(tx, id)
  return session?.fanId ?? null
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
 *
 * `maxAge: 0` is passed explicitly even though `@fastify/cookie` already sets it in
 * `clearCookie`: this way the `Max-Age=0` header is this code's promise, not a library
 * detail that a future upgrade could quietly change.
 */
export function clearSessionCookie(reply: FastifyReply, env: SessionConfig): void {
  reply.clearCookie(env.SESSION_COOKIE_NAME, { ...cookieAttributes(env), maxAge: 0 })
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
 * Marks a response as personal: no shared or browser cache may keep it.
 *
 * `no-store` stops both the browser and any proxy in front of it from writing the
 * response to disk; the public routes carry `public, max-age=15` instead and are the
 * only ones that should. `Vary: Cookie` is the second line: a cache that ignores
 * `no-store` still must not answer one fan's request with another fan's body.
 */
export function personalResponse(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store')
  reply.header('Vary', 'Cookie')
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
export function requireFan(deps: AuthDeps): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    // The shape is checked here, before the transaction, so a malformed cookie answers 401
    // without taking a connection. `readSession` repeats it for callers that do not come
    // through this hook.
    const sessionId = presentedSessionId(request, deps.env)
    if (sessionId === null) {
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
    personalResponse(reply)
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
