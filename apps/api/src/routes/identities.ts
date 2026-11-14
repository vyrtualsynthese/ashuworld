import type { FastifyInstance } from 'fastify'
import type { GameConfig } from '@ashuworld/gameconfig'
import {
  detachIdentity,
  getStanding,
  withTransaction,
  type DetachResult,
  type Queryable,
  type Standing,
} from '@ashuworld/ledger'
import { authenticatedFanId, requireFan, type AuthDeps } from '../auth/session.js'
import { writeRateLimit } from '../security/rateLimit.js'
import { errorBody, notFoundBody } from '../errors.js'

/** One provider account currently attached to the fan. */
export interface FanIdentity {
  id: string
  provider: string
  displayHandle: string
  /** Always true here: the query selects attached identities, so the field is explicit. */
  linked: boolean
}

/** Why a detach was refused. */
type DetachRefusal = Extract<DetachResult, { ok: false }>['reason']

/**
 * What the detach handler decided. The HTTP status is chosen from this, outside the
 * transaction, so no reply is sent while a connection is still held.
 */
type DetachOutcome =
  | { kind: 'missing' }
  | { kind: 'refused'; reason: DetachRefusal }
  | { kind: 'detached'; forfeitedEntries: number; standing: Standing }

/** The sentence beside each refusal code. The code is what clients branch on. */
const DETACH_REFUSALS: Readonly<Record<DetachRefusal, string>> = {
  last_identity:
    'an account must keep at least one identity; add another before detaching this one',
  not_attached: 'that identity is not attached to your account',
}

/**
 * The shape of a `provider_identities.id`: a canonical UUID.
 *
 * Checked before the query for the same reason a session id is: the column is a uuid, so
 * handing Postgres `not-a-uuid` raises a syntax error that would surface as a 500. A
 * caller-chosen string that cannot name a row is answered as a missing row instead, with
 * one round trip spared.
 */
const IDENTITY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isIdentityId(value: string): boolean {
  return IDENTITY_ID_PATTERN.test(value)
}

export interface IdentityRouteDeps extends AuthDeps {
  cfg: GameConfig
}

interface IdentityRow {
  id: string
  provider: string
  display_handle: string
}

/**
 * The identities currently attached to `fanId`, in provider then handle order.
 *
 * `fan_id` is the attachment: a detach sets it to null, so a detached identity is not in
 * this list at all. The order is total (the id breaks ties), which keeps the response
 * stable across calls and across a plan change.
 */
export async function listIdentities(tx: Queryable, fanId: string): Promise<FanIdentity[]> {
  const { rows } = await tx.query<IdentityRow>(
    `select id, provider, display_handle
       from provider_identities
      where fan_id = $1
      order by provider, display_handle, id`,
    [fanId],
  )
  return rows.map((identity) => ({
    id: identity.id,
    provider: identity.provider,
    displayHandle: identity.display_handle,
    linked: true,
  }))
}

/**
 * Detaches `identityId` from `fanId`, or says why it did not.
 *
 * The row is selected with `fan_id` in the predicate, so an id belonging to another fan
 * and an id that exists nowhere both match nothing. The handler turns both into the same
 * 404: answering 403 for the foreign one would confirm that the id is real, which is an
 * existence oracle over every fan's identities. The scoped read is not a substitute for
 * `detachIdentity`'s own ownership check; it is what lets the route tell "not yours or
 * not there" apart from "attached but refused".
 *
 * `getStanding` is called after the detach, inside the same transaction. Reading it
 * first would report the balance the fan is losing rather than the one they keep.
 */
export async function detachOwnedIdentity(
  tx: Queryable,
  cfg: GameConfig,
  fanId: string,
  identityId: string,
): Promise<DetachOutcome> {
  const owned = await tx.query<{ id: string }>(
    `select id
       from provider_identities
      where id = $1 and fan_id = $2`,
    [identityId, fanId],
  )
  if (owned.rows[0] === undefined) return { kind: 'missing' }

  const result = await detachIdentity(tx, { fanId, identityId, cfg })
  if (!result.ok) return { kind: 'refused', reason: result.reason }

  const standing = await getStanding(tx, fanId)
  return { kind: 'detached', forfeitedEntries: result.forfeitedEntries, standing }
}

/**
 * Turns "this cannot happen" into a compile error.
 *
 * A new arm on `DetachOutcome` would otherwise fall out of the switch and leave the
 * handler returning `undefined`, which Fastify sends as an empty 200 — a silent lie about
 * a detach that did not happen. The `never` parameter makes adding a kind without handling
 * it fail the build instead.
 */
function assertNever(outcome: never): never {
  throw new Error(`detach: unhandled outcome ${JSON.stringify(outcome)}`)
}

/**
 * The identity routes: what the caller holds now, and giving one back.
 *
 * There is deliberately no attach route. An identity is attached only by a provider
 * callback that has exchanged a code, because only the provider can prove who controls
 * the account; a request naming an id proves nothing. A `POST .../reattach` therefore
 * falls to the not-found handler like any other unknown path, and a test asserts the
 * registered route table, not just that one URL.
 *
 * Both handlers run behind `requireFan`, so the fan id is the one the session proved and
 * never one a caller supplied.
 */
export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityRouteDeps): void {
  const requireSession = requireFan(deps)

  app.get('/api/me/identities', { preHandler: requireSession }, async (request) => {
    const fanId = authenticatedFanId(request)
    return withTransaction(deps.pool, (tx) => listIdentities(tx, fanId))
  })

  app.post<{ Params: { identityId: string } }>(
    '/api/me/identities/:identityId/detach',
    { preHandler: requireSession, config: { rateLimit: writeRateLimit(deps.env) } },
    async (request, reply) => {
      const fanId = authenticatedFanId(request)
      const { identityId } = request.params
      if (!isIdentityId(identityId)) return reply.code(404).send(notFoundBody())

      const outcome = await withTransaction(deps.pool, (tx) =>
        detachOwnedIdentity(tx, deps.cfg, fanId, identityId),
      )

      switch (outcome.kind) {
        case 'missing':
          return reply.code(404).send(notFoundBody())
        case 'refused':
          return reply.code(409).send(errorBody(outcome.reason, DETACH_REFUSALS[outcome.reason]))
        case 'detached':
          return {
            forfeitedEntries: outcome.forfeitedEntries,
            balance: outcome.standing.balance,
            peakXp: outcome.standing.peakXp,
            level: outcome.standing.level,
          }
        default:
          return assertNever(outcome)
      }
    },
  )
}
