import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { expandLevels, type GameConfig } from '@ashuworld/gameconfig'
import {
  getFanByHandle,
  listLadder,
  withTransaction,
  type Queryable,
} from '@ashuworld/ledger'
import { notFoundBody } from '../errors.js'

export interface PublicRouteDeps {
  pool: Pool
  cfg: GameConfig
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

/** One row of the public game rules, in the order the page shows them. */
export interface PublicAction {
  key: string
  provider: string
  amount: number
  /** The recurring amount while the condition holds; 0 when the action has none. */
  monthly: number
  label: string
  description: string
}

export interface PublicLevel {
  level: number
  minXp: number
}

export interface PublicGame {
  actions: PublicAction[]
  levels: PublicLevel[]
}

/**
 * The game rules as the page may see them.
 *
 * Only the six fields the page renders leave this function: the config also carries
 * `version`, and a future field (an internal flag, a rollout switch) must not become
 * public just because someone added it next to an amount. `label` falls back to the key
 * so a hand-built config, which may omit the words, still renders something truthful.
 * `monthly` is normalised to 0 rather than left absent, so the page and its API contract
 * have one shape for an action with no recurring amount.
 *
 * The sort is by amount descending, then key ascending by code unit: the highest-value
 * action leads, and two actions with the same value have one fixed order on every
 * machine, so the page and its tests cannot disagree about a tie.
 */
export function publicGame(cfg: GameConfig): PublicGame {
  const actions = Object.entries(cfg.actions)
    .map(([key, action]) => ({
      key,
      provider: action.provider,
      amount: action.amount,
      monthly: action.monthly ?? 0,
      label: action.label ?? key,
      description: action.description ?? '',
    }))
    .sort((left, right) => {
      if (left.amount !== right.amount) return right.amount - left.amount
      if (left.key === right.key) return 0
      return left.key < right.key ? -1 : 1
    })
  // The config writes a prefix of the ladder; the page shows the curve continuing, so it
  // cannot imply a maximum level. Ten is enough to show the shape without turning the
  // answer into a long list.
  const levels = expandLevels(cfg, 10).map((row) => ({ level: row.level, minXp: row.minXp }))
  return { actions, levels }
}

/**
 * The public surface: the game rules, the ladder and a fan's profile.
 *
 * None of these routes has a preHandler and none reads the session cookie. A signed-in
 * fan is not special here — the tests pin that a request carrying a session gets
 * byte-for-byte the same body and no refreshed cookie, so "public" cannot quietly become
 * "public plus extras for me".
 *
 * An unknown handle answers with `notFoundBody`, the same bytes as a path that matches no
 * route, so the response cannot be used to discover who has an account.
 */
export function registerPublicRoutes(app: FastifyInstance, deps: PublicRouteDeps): void {
  app.get('/api/public/game', async (_request, reply) => {
    reply.header('Cache-Control', PUBLIC_CACHE)
    // The rules are not in the database, but they are read through the same snapshot as
    // the two other public pages so all three describe one moment of one deployment.
    return readSnapshot(deps.pool, async () => publicGame(deps.cfg))
  })

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
