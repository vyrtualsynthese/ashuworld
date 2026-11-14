import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import type { Pool } from 'pg'
import { ConfigError, type GameConfig } from '@ashuworld/gameconfig'
import { AwardConflictError, HandleTakenError, PenaltyError } from '@ashuworld/ledger'
import type { Env } from './config.js'
import { errorBody, notFoundBody } from './errors.js'
import { HandleExhaustedError } from './auth/handles.js'
import { createProviderRegistry, type ProviderRegistry } from './auth/providers.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerIdentityRoutes } from './routes/identities.js'
import { registerMeRoutes } from './routes/me.js'
import { registerPublicRoutes } from './routes/public.js'
import { helmetOptions } from './security/headers.js'
import { RATE_LIMITED_CODE, RATE_LIMITED_MESSAGE, rateLimitOptions } from './security/rateLimit.js'

export interface ServerDeps {
  pool: Pool
  cfg: GameConfig
  env: Env
  /**
   * Replaces pino's destination. Tests use it to inspect what would reach the log store;
   * production leaves it unset and pino writes to standard output.
   */
  logStream?: { write(line: string): void }
  /**
   * Replaces the provider registry. Production builds it from the environment; tests
   * use it to observe the arguments a route hands a provider, which are otherwise
   * invisible. A real provider registry is injected the same way.
   */
  providers?: ProviderRegistry
}

/**
 * The Fastify-generated client errors worth naming. They arrive with a `statusCode`
 * already set and no field-level detail, so the message stays generic and the status is
 * preserved. Anything else in 400–499 falls back to `client_error`.
 */
const CLIENT_ERRORS: Readonly<Record<number, { code: string; message: string }>> = {
  400: { code: 'bad_request', message: 'the request could not be understood' },
  413: { code: 'payload_too_large', message: 'the request body is too large' },
  415: {
    code: 'unsupported_media_type',
    message: 'the request content type is not supported',
  },
}

const FALLBACK_CLIENT_ERROR = { code: 'client_error', message: 'the request was refused' }

/**
 * A request URL without its query string.
 *
 * The OAuth callback carries `code` and `state` in the query, and both are credentials:
 * the code proves the provider's answer, the state proves the handshake. Neither may reach
 * a log line that an operator or a log-shipping pipeline can read.
 */
function pathOnly(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? ''
}

/**
 * Builds the HTTP layer and never opens a socket.
 *
 * `src/index.ts` owns `listen`; tests call `app.inject()`. That split is what lets every
 * route be exercised without a port, and it is why the pool and the game config are
 * injected rather than read from `process.env` or disk here.
 *
 * `cfg` reaches the sign-in callback, which recomputes a fan's standing when a first
 * login attaches an identity and may have prior earns to count.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const { pool, cfg, env } = deps
  // The three generics pin the instance to node's HTTP server and its request/response
  // types. Without them, a serializer that reads `request.ip` makes TypeScript resolve
  // the HTTP/2 overload, whose instance type no route or plugin here accepts.
  const app = Fastify<Server, IncomingMessage, ServerResponse>({
    // Behind the proxy, `request.ip` is only the client if the deployment says the
    // forwarding header can be trusted. Off by default so a caller cannot choose the
    // address the log records.
    trustProxy: env.TRUST_PROXY,
    logger: {
      level: env.LOG_LEVEL ?? 'info',
      // Fastify logs `req` for every request and again for the response; without this
      // serializer the callback's query string, and with it the code and state, would be
      // written twice per sign-in.
      //
      // The address fields are pino's own names (`remoteAddress`, `remotePort`), so a
      // log pipeline that already understands Fastify's default line keeps working.
      // They stay because abuse triage needs to know who sent a request; only the query
      // string is withheld.
      serializers: {
        req: (request: FastifyRequest) => ({
          method: request.method,
          url: pathOnly(request.url),
          remoteAddress: request.ip,
          // Omitted rather than logged as null when the socket has no port (the test
          // harness's fake socket, for one): `remotePort?: number` under
          // `exactOptionalPropertyTypes` accepts a number or no key, not `undefined`.
          ...(request.socket.remotePort === undefined
            ? {}
            : { remotePort: request.socket.remotePort }),
        }),
      },
      ...(deps.logStream === undefined ? {} : { stream: deps.logStream }),
    },
  })

  // Sessions arrive in the cookie `requireFan` reads, and leave in the one logout clears.
  // Registering the plugin here means every route that needs `reply.setCookie` or
  // `request.cookies` shares the same parser and serializer.
  app.register(cookie)

  // Every response carries the same deny-all header set, error bodies included. Registering
  // it once here, rather than per route, is what leaves a future route no way to opt out.
  app.register(helmet, helmetOptions())

  // In-memory at alpha: each pod counts its own clients. A shared store is what a
  // multi-replica deployment would need; see the design's accepted consequence.
  if (env.RATE_LIMIT_ENABLED) app.register(rateLimit, rateLimitOptions(env))

  /**
   * One error shape for every failure: `{ error: { code, message } }`.
   *
   * The split between the two 500 families is deliberate. A `ConfigError` or an
   * `AwardConflictError` means the deployment or the ledger is in a state this code does
   * not model, so the operator gets a named code and the real message. An unknown error
   * may carry anything (a SQL fragment, a token, a connection string), so its message is
   * withheld from the client and the full error goes to the log.
   */
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof PenaltyError) {
      return reply.code(400).send(errorBody(error.code, error.message))
    }

    if (error instanceof ConfigError) {
      app.log.error({ err: error }, 'the loaded game config is invalid')
      return reply.code(500).send(errorBody('invalid_config', error.message))
    }

    if (error instanceof AwardConflictError) {
      app.log.error({ err: error }, 'an award was refused by an unknown unique constraint')
      return reply.code(500).send(errorBody('award_conflict', error.message))
    }

    if (error instanceof HandleTakenError) {
      return reply.code(409).send(errorBody('handle_taken', error.message))
    }

    if (error instanceof HandleExhaustedError) {
      app.log.error({ err: error }, 'no free handle could be derived for a new fan')
      return reply.code(500).send(errorBody('handle_exhausted', error.message))
    }

    // Fastify's schema validation attaches the failures to the error. The message names
    // the field and what it expected, which is exactly what the caller needs to fix the
    // request, and it contains nothing from the server's own state.
    if (error.validation !== undefined) {
      return reply.code(400).send(errorBody('invalid_request', error.message))
    }

    // Fastify raises the rest of its client errors (malformed JSON, an oversized body,
    // an unsupported content type) with a `statusCode` of their own. Reporting them as
    // 500 would hide the caller's mistake and make every later route inherit the lie;
    // the message stays generic because Fastify's own one is not always useful to a
    // client, but the status and the envelope are preserved.
    const status = error.statusCode
    if (status === 429) {
      const retryAfter = (error as { retryAfter?: unknown }).retryAfter
      if (typeof retryAfter === 'number') {
        reply.header('Retry-After', String(Math.ceil(retryAfter / 1000)))
      }
      return reply.code(429).send(errorBody(RATE_LIMITED_CODE, RATE_LIMITED_MESSAGE))
    }
    if (typeof status === 'number' && status >= 400 && status <= 499) {
      const response = CLIENT_ERRORS[status] ?? FALLBACK_CLIENT_ERROR
      return reply.code(status).send(errorBody(response.code, response.message))
    }

    app.log.error(
      { err: error, url: pathOnly(request.url), method: request.method },
      'unhandled error while serving a request',
    )
    return reply
      .code(500)
      .send(errorBody('internal', 'the server could not complete the request'))
  })

  app.setNotFoundHandler((request, reply) => {
    // The request details go to the log, never into the response: a URL can carry a
    // token or a probe path, and a 404 is the easiest place to leak one by accident.
    // The query is dropped from the log line too: a mistyped callback path puts a live
    // authorization `code` and `state` there, and those are credentials.
    request.log.info(
      { method: request.method, url: pathOnly(request.url) },
      'no route matches the request',
    )
    return reply.code(404).send(notFoundBody())
  })

  // One registry for the whole instance. The capability route advertises exactly the
  // doors the sign-in routes will accept, so the page cannot offer a button whose target
  // answers `unknown_provider`. Building it once also means a test that injects a
  // registry sees that same registry from both surfaces.
  const providers = deps.providers ?? createProviderRegistry(env)

  // The limiter reads each route's `config.rateLimit` from an `onRoute` hook that only
  // exists once the plugin has loaded. A plugin registered here loads at boot, while a
  // route added directly in this function is added immediately, so declaring the routes
  // inside `after` is what makes the per-route budgets apply. `after` keeps `buildServer`
  // synchronous, which every test and `src/index.ts` relies on.
  //
  // A route registered directly in `buildServer`, outside this block, fails silently: the
  // hook has not loaded yet, so its `config.rateLimit` is ignored and it keeps only the
  // global public budget.
  app.after(() => {
    registerHealthRoutes(app, pool)
    registerPublicRoutes(app, { pool, cfg, providers })
    registerMeRoutes(app, { pool, env })
    registerIdentityRoutes(app, { pool, cfg, env })
    registerAuthRoutes(app, { pool, cfg, env, providers })
  })
  return app
}
