import type { RateLimitOptions, RateLimitPluginOptions } from '@fastify/rate-limit'

/** The five values the rate limiter reads from the process environment. */
export interface RateLimitEnv {
  RATE_LIMIT_ENABLED: boolean
  RATE_LIMIT_WINDOW_MS: number
  RATE_LIMIT_PUBLIC_MAX: number
  RATE_LIMIT_AUTH_MAX: number
  RATE_LIMIT_WRITE_MAX: number
}

/** The code and message every 429 carries, so the plugin and the error handler agree. */
export const RATE_LIMITED_CODE = 'rate_limited'
export const RATE_LIMITED_MESSAGE =
  'too many requests in a short window; wait a moment and try again'

/**
 * Defaults for every route.
 *
 * The public bucket is deliberately generous: the ladder and profile pages are read on
 * every load, sometimes several times per second by a browser and by the status widgets.
 * A limit tight enough to be noticeable there would punish normal use, so it only stops a
 * script that hammers the api far faster than a person can.
 */
export function rateLimitOptions(env: RateLimitEnv): RateLimitPluginOptions {
  return {
    global: true,
    max: env.RATE_LIMIT_PUBLIC_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      code: RATE_LIMITED_CODE,
      retryAfter: context.ttl,
      message: RATE_LIMITED_MESSAGE,
    }),
  }
}

/**
 * The auth budget is strict because a sign-in start is cheap for us and expensive for the
 * provider: each one creates a state row and a redirect. A limit this low is invisible to
 * a person signing in twice and stops a script from enumerating providers or exhausting
 * the state table.
 *
 * It is a budget **per route**, not one counter shared by `/auth/start`, `/auth/callback`
 * and `/auth/logout`: each route that declares its own `config.rateLimit` gets its own
 * store from `@fastify/rate-limit` at alpha, so `groupId` buys nothing across routes. That
 * is accepted: every auth route is bounded on its own, and only `/start` creates a
 * handshake row, so the expensive operation keeps the strict limit that matters. A shared
 * store, which is what would make the group a single counter, is the same deferred move as
 * the in-memory store itself.
 */
export const AUTH_RATE_LIMIT_GROUP = 'auth'

/** Destructive writes get their own strict bucket so a retry loop cannot repeat them. */
export const WRITE_RATE_LIMIT_GROUP = 'write'

/**
 * The per-route config for a sign-in or sign-out route.
 *
 * `groupId` names the bucket so a future shared store can key on it. Today each route that
 * sets this config gets its own independent counter; it is not a single budget shared
 * across the auth routes. The global bucket still covers every other route.
 */
export function authRateLimit(env: RateLimitEnv): RateLimitOptions {
  return {
    max: env.RATE_LIMIT_AUTH_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    groupId: AUTH_RATE_LIMIT_GROUP,
  }
}

/** The per-route config for a destructive write: its own bucket and its own budget. */
export function writeRateLimit(env: RateLimitEnv): RateLimitOptions {
  return {
    max: env.RATE_LIMIT_WRITE_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    groupId: WRITE_RATE_LIMIT_GROUP,
  }
}
