import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { GameConfig } from '@ashuworld/gameconfig'
import type { IdentityProfile } from '@ashuworld/providers'
import { ensureIdentity, linkIdentity, withTransaction } from '@ashuworld/ledger'
import type { Env } from '../config.js'
import { errorBody } from '../errors.js'
import {
  HANDSHAKE_TTL_MINUTES,
  consumeHandshake,
  startHandshake,
  type Handshake,
  type HandshakePurpose,
} from '../auth/handshake.js'
import { createFanWithUniqueHandle } from '../auth/handles.js'
import {
  ProviderExchangeError,
  createProviderRegistry,
  type ProviderRegistry,
} from '../auth/providers.js'
import {
  authenticatedFanId,
  createSession,
  requireFan,
  sessionFanId,
  setSessionCookie,
} from '../auth/session.js'

export interface AuthRouteDeps {
  pool: Pool
  cfg: GameConfig
  env: Env
  /**
   * The providers this deployment accepts. Production leaves it unset and the registry
   * is built from `env`; a test supplies one to inspect what the routes hand a provider,
   * and a real provider registry can be injected the same way.
   */
  providers?: ProviderRegistry
}

interface StartQuery {
  purpose?: unknown
  handle?: unknown
}

interface CallbackQuery {
  code?: unknown
  state?: unknown
}

const UNKNOWN_PROVIDER = 'that sign-in provider is not configured'
const HANDSHAKE_INVALID = 'this sign-in link has expired or was already used'
const UNAUTHENTICATED = 'sign in to continue'

/**
 * The cookie that ties a handshake to the browser that started it.
 *
 * Without it, an attacker can complete a login in their own browser, stop at the 302 to
 * the callback, and send that URL to a victim. The victim's callback would consume the
 * state and receive a session for the attacker's fan (login CSRF). The state alone is a
 * bearer value, so the start records it in this cookie and the callback requires the two
 * to match before it consumes anything.
 *
 * `Path=/auth` keeps it away from the rest of the site, and the ten-minute lifetime
 * matches the handshake row it protects.
 */
export const OAUTH_STATE_COOKIE_NAME = 'ashu_oauth_state'
const OAUTH_STATE_PATH = '/auth'
const OAUTH_STATE_MAX_AGE_SECONDS = HANDSHAKE_TTL_MINUTES * 60

/**
 * Fastify hands query values through untouched. A value is only used when it arrived as
 * exactly one non-empty string; a duplicated parameter arrives as an array and must not
 * be mistaken for its first element.
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * `purpose` defaults to `login` only when it is absent. A duplicated parameter
 * (`?purpose=link&purpose=login`) or an empty value is refused rather than silently
 * starting a login, because the two readings of the request disagree and neither is safe
 * to guess.
 */
function parsePurpose(value: unknown): HandshakePurpose | null {
  if (value === undefined) return 'login'
  if (value === 'login' || value === 'link') return value
  return null
}

function oauthStateCookieAttributes(env: Env): {
  httpOnly: true
  sameSite: 'lax'
  path: string
  secure: boolean
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: OAUTH_STATE_PATH,
    secure: env.COOKIE_SECURE,
  }
}

function setOAuthStateCookie(reply: FastifyReply, env: Env, state: string): void {
  reply.setCookie(OAUTH_STATE_COOKIE_NAME, state, {
    ...oauthStateCookieAttributes(env),
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  })
}

function clearOAuthStateCookie(reply: FastifyReply, env: Env): void {
  reply.clearCookie(OAUTH_STATE_COOKIE_NAME, {
    ...oauthStateCookieAttributes(env),
    maxAge: 0,
  })
}

/**
 * The provider's callback on this deployment. Built from `PUBLIC_BASE_URL`, never from the
 * incoming request's Host header: a Host-shaped redirect URI would let a caller point the
 * provider at a host of their choosing.
 */
function callbackUri(env: Env, provider: string): string {
  return new URL(`/auth/${provider}/callback`, env.PUBLIC_BASE_URL).toString()
}

/** What the login half of the callback decided. */
type LoginOutcome =
  | { kind: 'session'; sessionId: string }
  | { kind: 'reattach' }

/** What the link half of the callback decided. */
type LinkOutcome =
  | { kind: 'linked' }
  | { kind: 'unauthenticated' }
  | { kind: 'not_owner' }
  | { kind: 'same_provider' }
  | { kind: 'already_owned' }

/**
 * Resolves the fan behind a provider identity, in the order the plan fixes:
 *
 * 1. the identity is attached to a fan → sign that fan in;
 * 2. the identity exists but is detached (`first_linked_at` set) → send the fan to
 *    `/account?reattach=<provider>` and attach nothing, because signing in would silently
 *    undo a detach the fan chose;
 * 3. the identity is unknown → create a fan from the display handle, attach the identity
 *    and sign the fan in.
 *
 * The identity row is locked before the decision, so two simultaneous first logins cannot
 * both see "unknown" and create two fans: the second waits, then sees the first fan and
 * signs into it. `ensureIdentity` alone does not give that, because it only serialises the
 * identity insert, not the fan lookup that follows.
 */
async function resolveLogin(
  deps: AuthRouteDeps,
  profile: IdentityProfile,
): Promise<LoginOutcome> {
  return withTransaction(deps.pool, async (tx) => {
    const identity = await ensureIdentity(tx, profile)

    const { rows } = await tx.query<{ fan_id: string | null; first_linked_at: Date | null }>(
      `select fan_id, first_linked_at
         from provider_identities
        where id = $1
        for update`,
      [identity.id],
    )
    const row = rows[0]
    if (row === undefined) {
      throw new Error(`resolveLogin: provider identity ${identity.id} vanished while it was locked`)
    }

    let fanId = row.fan_id
    if (fanId === null) {
      if (row.first_linked_at !== null) return { kind: 'reattach' }

      const fan = await createFanWithUniqueHandle(tx, {
        displayHandle: profile.displayHandle,
        displayName: profile.displayName,
      })
      const linked = await linkIdentity(tx, { fanId: fan.id, identityId: identity.id, cfg: deps.cfg })
      if (!linked.ok) {
        // The row is locked and the fan is brand new, so nothing can have taken either
        // side of the link. Reaching here means the ledger no longer matches this code.
        throw new Error(`resolveLogin: linking a new fan was refused with ${linked.reason}`)
      }
      fanId = fan.id
    }

    return { kind: 'session', sessionId: await createSession(tx, fanId) }
  })
}

/**
 * Attaches the identity the provider just proved to the fan that started the handshake.
 *
 * This is the only re-attach path. The handshake row names the fan, and the callback also
 * requires a live session for that same fan: possession of the state alone is not proof
 * that the person at the browser is the account owner. A different fan's session is
 * refused with 403 and attaches nothing. The handshake has already been consumed at that
 * point, so the wrong-owner attempt burns it; that is the price of consuming the state
 * before deciding, and the alternative (peeking first, then deleting) leaves a race.
 */
async function resolveLink(
  deps: AuthRouteDeps,
  request: FastifyRequest,
  handshake: Extract<Handshake, { purpose: 'link' }>,
  profile: IdentityProfile,
): Promise<LinkOutcome> {
  return withTransaction(deps.pool, async (tx) => {
    const ownerFanId = await sessionFanId(tx, request, deps.env)
    if (ownerFanId === null) return { kind: 'unauthenticated' }
    if (ownerFanId !== handshake.fanId) return { kind: 'not_owner' }

    const identity = await ensureIdentity(tx, profile)
    const linked = await linkIdentity(tx, {
      fanId: handshake.fanId,
      identityId: identity.id,
      cfg: deps.cfg,
    })
    if (!linked.ok) return { kind: linked.reason }
    return { kind: 'linked' }
  })
}

/**
 * The two sign-in routes.
 *
 * `start` records a handshake and redirects. It never sets a cookie: nothing has been
 * proved yet, and a cookie issued there would be a session for nobody. `callback` is the
 * only route in the service that may call `setSessionCookie`, and only after `exchange`
 * has returned an identity — ruling R18.
 *
 * The dev provider's door is registered only when `ALLOW_DEV_LOGIN` is true. It is a real
 * backdoor when switched on, which is why it defaults to off everywhere including tests
 * that do not ask for it.
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const providers = deps.providers ?? createProviderRegistry(deps.env)
  const requireSession = requireFan({ pool: deps.pool, env: deps.env })

  app.get<{ Params: { provider: string }; Querystring: StartQuery }>(
    '/auth/:provider/start',
    {
      preHandler: async (request, reply) => {
        // Only `link` needs a fan. Enforcing it in the preHandler keeps the one code path
        // that turns a cookie into a fan, instead of a second reading of the cookie here.
        if (parsePurpose(request.query.purpose) === 'link') {
          // Fastify calls a hook with `this` bound to the instance; calling one by hand has
          // to supply the same receiver for the hook's own type to hold.
          await requireSession.call(app, request, reply)
        }
      },
    },
    async (request, reply) => {
      const provider = providers.get(request.params.provider)
      if (provider === undefined) {
        return reply.code(400).send(errorBody('unknown_provider', UNKNOWN_PROVIDER))
      }

      const purpose = parsePurpose(request.query.purpose)
      if (purpose === null) {
        return reply.code(400).send(errorBody('invalid_purpose', 'purpose must be "login" or "link"'))
      }

      // `requireSession` above guarantees a fan for `link`; `authenticatedFanId` turns a
      // wiring mistake into a loud failure rather than a handshake with no owner.
      const fanId = purpose === 'link' ? authenticatedFanId(request) : null
      const started = await withTransaction(deps.pool, (tx) =>
        startHandshake(tx, {
          provider,
          purpose,
          fanId,
          redirectUri: callbackUri(deps.env, provider.name),
          loginHint: text(request.query.handle),
        }),
      )

      setOAuthStateCookie(reply, deps.env, started.state)
      return reply.redirect(started.authorizeUrl, 302)
    },
  )

  app.get<{ Params: { provider: string }; Querystring: CallbackQuery }>(
    '/auth/:provider/callback',
    async (request, reply) => {
      // Every terminal path clears the binding cookie. Doing it up front means no branch
      // below has to remember: an error, a mismatch and a success all leave the browser
      // with the cookie removed. Queuing it before the session cookie is set does not
      // affect `request.cookies`, which was already parsed.
      clearOAuthStateCookie(reply, deps.env)

      const provider = providers.get(request.params.provider)
      if (provider === undefined) {
        return reply.code(400).send(errorBody('unknown_provider', UNKNOWN_PROVIDER))
      }

      const state = text(request.query.state)
      const code = text(request.query.code)
      if (state === undefined || code === undefined) {
        return reply
          .code(400)
          .send(errorBody('invalid_request', 'the callback needs both a "code" and a "state"'))
      }

      // The browser-binding check happens before consumption. A callback URL copied to a
      // victim's browser arrives without that browser's matching cookie, so it is refused
      // and the state stays usable by the browser that really started the handshake.
      const boundState = request.cookies[OAUTH_STATE_COOKIE_NAME]
      if (boundState === undefined || boundState !== state) {
        return reply.code(400).send(errorBody('handshake_invalid', HANDSHAKE_INVALID))
      }

      // Consumed before the exchange, so a code cannot be replayed against a second
      // handshake and a provider that hangs cannot leave the state redeemable.
      const handshake = await withTransaction(deps.pool, (tx) =>
        consumeHandshake(tx, { state, provider: provider.name }),
      )
      if (handshake === null) {
        return reply.code(400).send(errorBody('handshake_invalid', HANDSHAKE_INVALID))
      }

      let profile: IdentityProfile
      try {
        profile = await provider.exchange({
          code,
          redirectUri: callbackUri(deps.env, provider.name),
        })
      } catch (error) {
        if (!(error instanceof ProviderExchangeError)) throw error
        return reply.code(error.httpStatus).send(errorBody('provider_error', error.message))
      }

      if (handshake.purpose === 'link') {
        const outcome = await resolveLink(deps, request, handshake, profile)
        switch (outcome.kind) {
          case 'unauthenticated':
            return reply.code(401).send(errorBody('unauthenticated', UNAUTHENTICATED))
          case 'not_owner':
            return reply
              .code(403)
              .send(errorBody('link_not_owner', 'this sign-in link was started by another fan'))
          case 'same_provider':
            return reply.code(409).send(
              errorBody(
                'same_provider',
                `this account already has a ${provider.name} identity; detach it before linking another`,
              ),
            )
          case 'already_owned':
            return reply
              .code(409)
              .send(errorBody('identity_owned', 'that provider account is already attached to another fan'))
          case 'linked':
            // No cookie: this fan already has a session, and a link proves an identity,
            // not a new browser. Minting a second session here would add nothing.
            return reply.redirect('/account', 302)
        }
      }

      const outcome = await resolveLogin(deps, profile)
      if (outcome.kind === 'reattach') {
        // The identity is detached but was once attached. Signing in would silently undo
        // the fan's own detach; ask them to confirm by starting a link handshake instead.
        return reply.redirect(`/account?reattach=${encodeURIComponent(provider.name)}`, 302)
      }

      setSessionCookie(reply, deps.env, outcome.sessionId)
      return reply.redirect('/account', 302)
    },
  )
}
