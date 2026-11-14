import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import type { Pool } from 'pg'
import { ConfigError, type GameConfig } from '@ashuworld/gameconfig'
import { AwardConflictError, HandleTakenError, PenaltyError } from '@ashuworld/ledger'
import type { Env } from './config.js'
import { errorBody } from './errors.js'
import { registerHealthRoutes } from './routes/health.js'
import { registerMeRoutes } from './routes/me.js'

export interface ServerDeps {
  pool: Pool
  cfg: GameConfig
  env: Env
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

const NOT_FOUND_MESSAGE = 'the requested resource does not exist'

/**
 * Builds the HTTP layer and never opens a socket.
 *
 * `src/index.ts` owns `listen`; tests call `app.inject()`. That split is what lets every
 * route be exercised without a port, and it is why the pool and the game config are
 * injected rather than read from `process.env` or disk here.
 *
 * `cfg` is not used by this task's routes yet. It is part of the factory on purpose: the
 * award, penalty and standing routes that follow all need it, and threading it later
 * would mean changing every call site.
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const { pool, env } = deps
  const app = Fastify({ logger: true })

  // Sessions arrive in the cookie `requireFan` reads, and leave in the one logout clears.
  // Registering the plugin here means every route that needs `reply.setCookie` or
  // `request.cookies` shares the same parser and serializer.
  app.register(cookie)

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
    if (typeof status === 'number' && status >= 400 && status <= 499) {
      const response = CLIENT_ERRORS[status] ?? FALLBACK_CLIENT_ERROR
      return reply.code(status).send(errorBody(response.code, response.message))
    }

    app.log.error({ err: error, url: request.url, method: request.method }, 'unhandled error while serving a request')
    return reply
      .code(500)
      .send(errorBody('internal', 'the server could not complete the request'))
  })

  app.setNotFoundHandler((request, reply) => {
    // The request details go to the log, never into the response: a URL can carry a
    // token or a probe path, and a 404 is the easiest place to leak one by accident.
    request.log.info({ method: request.method, url: request.url }, 'no route matches the request')
    return reply.code(404).send(errorBody('not_found', NOT_FOUND_MESSAGE))
  })

  registerHealthRoutes(app, pool)
  registerMeRoutes(app, { pool, env })
  return app
}
