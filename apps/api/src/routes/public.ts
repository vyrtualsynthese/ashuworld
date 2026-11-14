import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import {
  getFanByHandle,
  listLadder,
  withTransaction,
  type Queryable,
} from '@ashuworld/ledger'
import { notFoundBody } from '../errors.js'

export interface PublicRouteDeps {
  pool: Pool
}

/**
 * Runs a public page's reads in a repeatable-read transaction.
 *
 * `withTransaction` alone puts each statement in its own READ COMMITTED snapshot, so the
 * two ladder queries could see an award that lands between them: the linked list from
 * before it and the free-standing list from after. Repeatable read pins one snapshot for
 * the whole transaction, which is what lets the page describe a single moment.
 *
 * The statement must be the first one in the transaction, which is why this wrapper owns
 * the transaction rather than leaving it to the handler.
 *
 * The cost is that a write conflict raises SQLSTATE 40001 instead of waiting. Nothing
 * written here can conflict — both pages are read-only — so this code does not retry: a
 * serialization failure would reach the shared error handler as an `internal` 500 rather
 * than silently showing a mixed page. A future write added to these routes has to add a
 * retry, or it will fail under concurrent load.
 */
async function readSnapshot<T>(pool: Pool, work: (tx: Queryable) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (tx) => {
    await tx.query('set transaction isolation level repeatable read')
    return work(tx)
  })
}

/**
 * A public page is the same for everyone and moves at the pace of an earn, not a click,
 * so a short shared-cache window is safe and keeps a shared link off the origin. The
 * session cookie is ignored on these routes, so there is nothing per-caller to leak.
 */
const PUBLIC_CACHE = 'public, max-age=15'

/**
 * A 404 is heuristically cacheable, which would be a bug here: a handle with no account
 * today can have one after the next sign-up, and a CDN holding "not found" would keep
 * answering that long after the route started answering 200.
 */
const NOT_FOUND_CACHE = 'no-store'

/**
 * The public surface: the ladder and a fan's profile.
 *
 * Neither route has a preHandler and neither reads the session cookie. A signed-in fan is
 * not special here — the tests pin that a request carrying a session gets byte-for-byte
 * the same body and no refreshed cookie, so "public" cannot quietly become "public plus
 * extras for me".
 *
 * An unknown handle answers with `notFoundBody`, the same bytes as a path that matches no
 * route, so the response cannot be used to discover who has an account.
 */
export function registerPublicRoutes(app: FastifyInstance, deps: PublicRouteDeps): void {
  app.get('/api/public/ladder', async (_request, reply) => {
    reply.header('Cache-Control', PUBLIC_CACHE)
    return readSnapshot(deps.pool, (tx) => listLadder(tx))
  })

  app.get<{ Params: { handle: string } }>(
    '/api/public/fans/:handle',
    async (request, reply) => {
      reply.header('Cache-Control', PUBLIC_CACHE)
      const profile = await readSnapshot(deps.pool, (tx) =>
        getFanByHandle(tx, request.params.handle),
      )
      if (profile === null) {
        // Set after the successful branch's public header, so the 404 replaces it rather
        // than carrying a cacheable directive by accident.
        reply.header('Cache-Control', NOT_FOUND_CACHE)
        return reply.code(404).send(notFoundBody())
      }
      return profile
    },
  )
}
