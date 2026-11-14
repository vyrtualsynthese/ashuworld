import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { withTransaction } from '@ashuworld/ledger'
import { errorBody } from '../errors.js'

/**
 * How long a health probe may take before the database is declared unavailable.
 *
 * The probe runs as a statement inside a transaction, so `statement_timeout` makes
 * Postgres itself end a query that stops answering. That is the mechanism that matters:
 * it is enforced by the server, so the query rejects, the transaction helper's `finally`
 * releases the client, and the pool does not lose a connection per probe.
 */
export const HEALTH_TIMEOUT_MS = 2_000

/**
 * A second, slightly larger bound for the case `statement_timeout` cannot cover at all:
 * a driver that never returns from a call (a frozen socket, or the never-answering fake
 * in the test). Without it the route could wait forever even though the SQL would have
 * timed out.
 */
const HEALTH_DEADLINE_MS = HEALTH_TIMEOUT_MS + 500

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`health probe did not finish within ${ms}ms`)), ms)
  })
  return Promise.race([work, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

async function probeDatabase(pool: Pool): Promise<void> {
  await withTransaction(pool, async (tx) => {
    // `set local` is scoped to this transaction; it cannot follow the client back to the
    // pool and change the timeout of unrelated queries.
    await tx.query(`set local statement_timeout = ${HEALTH_TIMEOUT_MS}`)
    await tx.query('select 1')
  })
}

/**
 * Liveness with a point: the process answering is not enough, because a server that has
 * lost its database can accept requests but cannot serve any of them. A `select 1` fails
 * fast when the database is gone, and the failure is reported in the same
 * `{ error: { code, message } }` shape as every other error.
 */
export function registerHealthRoutes(app: FastifyInstance, pool: Pool): void {
  app.get('/api/health', async (_request, reply) => {
    try {
      await withDeadline(probeDatabase(pool), HEALTH_DEADLINE_MS)
    } catch (error) {
      app.log.error({ err: error }, 'health check failed: the database did not answer')
      return reply
        .code(503)
        .send(errorBody('database_unavailable', 'the database did not answer a health check'))
    }
    return { ok: true }
  })
}
