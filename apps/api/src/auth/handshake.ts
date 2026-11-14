import { randomBytes } from 'node:crypto'
import type { ProviderName } from '@ashuworld/providers'
import type { Queryable } from '@ashuworld/ledger'
import type { OAuthProvider } from './providers.js'

/**
 * Sign-in handshakes: the state that ties a callback to a start this server issued.
 *
 * The state is 32 random bytes rendered base64url — 43 characters, the same entropy as a
 * session id. It is stored as the primary key, so guessing one is not a realistic attack
 * and hashing it would only add a lookup without adding secrecy.
 *
 * A handshake lives ten minutes and is consumed exactly once: the callback deletes the
 * row with `returning`, so a replay finds nothing even if two callbacks arrive at the same
 * instant. A row that has expired is deleted too, and reported as invalid; leaving it
 * would let an old link work forever.
 */

export type HandshakePurpose = 'login' | 'link'

export const HANDSHAKE_TTL_MINUTES = 10
export const HANDSHAKE_STATE_BYTES = 32

/** 32 bytes base64url without padding: exactly 43 characters. */
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * The shape of a terms document version, such as `2026-11-14` or `2026-11-14.2`.
 *
 * The browser sends the version of the document it actually rendered, so this only checks
 * the shape: whether that version exists is the site's business, and the value stored is
 * the evidence of what the fan was shown, not a lookup key.
 */
export const TERMS_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}(\.\d+)?$/

export interface StartHandshakeInput {
  /** The provider instance, not just its name: the same call builds the authorize URL. */
  provider: OAuthProvider
  purpose: HandshakePurpose
  /** The fan a `link` handshake will attach to. A `login` handshake has no owner yet. */
  fanId: string | null
  /**
   * The terms version the browser rendered and the fan accepted, or null when no
   * acceptance was collected (a `link`, which starts from an already signed-in session).
   */
  termsVersion: string | null
  redirectUri: string
  loginHint?: string | undefined
}

/**
 * What a consumed handshake remembers.
 *
 * A discriminated union rather than `{ purpose, fanId: string | null }`: the database's
 * `link_handshake_has_fan` check guarantees a link row names a fan, and the type lets the
 * callback rely on that without re-checking an impossible state.
 */
export type Handshake =
  | {
      provider: ProviderName
      purpose: 'login'
      fanId: string | null
      termsVersion: string | null
    }
  | { provider: ProviderName; purpose: 'link'; fanId: string; termsVersion: string | null }

export interface ConsumeHandshakeInput {
  state: string
  /**
   * The provider whose callback is redeeming the state. The lookup is scoped by it, so a
   * state issued for one provider is not a ticked for another.
   */
  provider: ProviderName
}

/**
 * Records a new handshake and returns its state and the provider's authorize URL.
 *
 * The row is written first: a URL handed to the fan before its state exists would make
 * every callback fail. `now() + make_interval` keeps the expiry on the database clock, so
 * a server whose own clock drifts cannot extend or shorten a handshake.
 */
export async function startHandshake(
  tx: Queryable,
  input: StartHandshakeInput,
): Promise<{ state: string; authorizeUrl: string }> {
  if (input.purpose === 'link' && input.fanId === null) {
    throw new Error('startHandshake: a link handshake needs a signed-in fan to attach to')
  }

  const state = randomBytes(HANDSHAKE_STATE_BYTES).toString('base64url')
  await tx.query(
    `insert into oauth_handshakes (state, provider, purpose, fan_id, terms_version, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
    [
      state,
      input.provider.name,
      input.purpose,
      input.fanId,
      input.termsVersion,
      HANDSHAKE_TTL_MINUTES,
    ],
  )

  return {
    state,
    authorizeUrl: input.provider.authorizeUrl({
      state,
      redirectUri: input.redirectUri,
      loginHint: input.loginHint,
    }),
  }
}

/**
 * Redeems a state, or answers null when it is malformed, unknown, expired or already used.
 *
 * The delete is the check. Two callbacks presenting one state both run this statement;
 * the first deletes the row and gets it back, the second finds nothing. A read-then-delete
 * would leave a window where both pass the read.
 *
 * The provider is part of the `where`, so a state issued by provider A cannot be redeemed
 * at provider B's callback — and the failed attempt does not delete it, leaving it usable
 * by its rightful provider.
 *
 * A malformed state is rejected before any query: it cannot be a value this code issued,
 * and there is no reason to send arbitrary caller input to the database.
 */
export async function consumeHandshake(
  tx: Queryable,
  input: ConsumeHandshakeInput,
): Promise<Handshake | null> {
  if (!STATE_PATTERN.test(input.state)) return null

  const { rows } = await tx.query<{
    provider: ProviderName
    purpose: HandshakePurpose
    fan_id: string | null
    terms_version: string | null
    live: boolean
  }>(
    `delete from oauth_handshakes
      where state = $1 and provider = $2
      returning provider, purpose, fan_id, terms_version, expires_at > now() as live`,
    [input.state, input.provider],
  )

  const row = rows[0]
  if (row === undefined || !row.live) return null

  if (row.purpose === 'link') {
    // The table's `link_handshake_has_fan` check makes this true for every link row; the
    // cast states that guarantee for the caller instead of widening the type to include a
    // state the database forbids.
    return {
      provider: row.provider,
      purpose: 'link',
      fanId: row.fan_id as string,
      termsVersion: row.terms_version,
    }
  }
  return {
    provider: row.provider,
    purpose: 'login',
    fanId: row.fan_id,
    termsVersion: row.terms_version,
  }
}
