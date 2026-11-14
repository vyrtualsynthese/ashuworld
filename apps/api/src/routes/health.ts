import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'

/**
 * Liveness with a point: the process answering is not enough, because a server that has
 * lost its database can accept requests but cannot serve any of them. A `select 1`
 * through the pool fails fast when every connection is broken, and the failure is
 * reported in the same `{ error: { code, message } }` shape as every other error.
 */
export function registerHealthRoutes(app: FastifyInstance, pool: Pool): void {
  app.get('/api/health', async (_request, reply) => {
    try {
      await pool.query('select 1')
    } catch (error) {
      app.log.error({ err: error }, 'health check failed: the database did not answer')
      return reply.code(503).send({
        error: {
          code: 'database_unavailable',
          message: 'the database did not answer a health check',
        },
      })
    }
    return { ok: true }
  })
}
