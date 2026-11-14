import type { RateLimitPluginOptions } from '@fastify/rate-limit'

/** The five values the rate limiter reads from the process environment. */
export interface RateLimitEnv {
  RATE_LIMIT_ENABLED: boolean
  RATE_LIMIT_WINDOW_MS: number
  RATE_LIMIT_PUBLIC_MAX: number
  RATE_LIMIT_AUTH_MAX: number
  RATE_LIMIT_WRITE_MAX: number
}

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
      code: 'rate_limited',
      retryAfter: context.ttl,
      message: 'too many requests in a short window; wait a moment and try again',
    }),
  }
}

/**
 * The auth bucket is strict because a sign-in start is cheap for us and expensive for the
 * provider: each one creates a state row and a redirect. A limit this low is invisible to
 * a person signing in twice and stops a script from enumerating providers or exhausting
 * the state table, while keeping the shared bucket readable during an attempt.
 */
export const AUTH_RATE_LIMIT_GROUP = 'auth'

/** Destructive writes get their own strict bucket so a retry loop cannot repeat them. */
export const WRITE_RATE_LIMIT_GROUP = 'write'
