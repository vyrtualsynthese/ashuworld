import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import type { Pool } from 'pg'
import { ConfigError, type GameConfig } from '@ashuworld/gameconfig'
import { AwardConflictError, HandleTakenError, PenaltyError } from '@ashuworld/ledger'
import type { Env } from './config.js'
import { registerHealthRoutes } from './routes/health.js'

export interface ServerDeps {
  pool: Pool
  cfg: GameConfig
  env: Env
}

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
  const { pool } = deps
  const app = Fastify({ logger: true })

  // Sessions arrive in Task 9. Registering the plugin now means the cookie decorators
  // exist from the first route that needs them instead of appearing as a surprise.
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
      return reply.code(400).send({ error: { code: error.code, message: error.message } })
    }

    if (error instanceof ConfigError) {
      app.log.error({ err: error }, 'the loaded game config is invalid')
      return reply.code(500).send({ error: { code: 'invalid_config', message: error.message } })
    }

    if (error instanceof AwardConflictError) {
      app.log.error({ err: error }, 'an award was refused by an unknown unique constraint')
      return reply.code(500).send({ error: { code: 'award_conflict', message: error.message } })
    }

    if (error instanceof HandleTakenError) {
      return reply.code(409).send({ error: { code: 'handle_taken', message: error.message } })
    }

    // Fastify's schema validation attaches the failures to the error. The message names
    // the field and what it expected, which is exactly what the caller needs to fix the
    // request, and it contains nothing from the server's own state.
    if (error.validation !== undefined) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: error.message } })
    }

    app.log.error({ err: error, url: request.url, method: request.method }, 'unhandled error while serving a request')
    return reply.code(500).send({
      error: { code: 'internal', message: 'the server could not complete the request' },
    })
  })

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: { code: 'not_found', message: `no route matches ${request.method} ${request.url}` },
    })
  })

  registerHealthRoutes(app, pool)
  return app
}
