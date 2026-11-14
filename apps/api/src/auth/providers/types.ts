import type { IdentityProfile, ProviderName } from '@ashuworld/providers'

/**
 * The provider contract and its error.
 *
 * These live apart from `../providers.js` — the module that builds the registry — so a
 * concrete provider can implement the contract without importing the module that imports
 * it. `../providers.js` re-exports everything here, so callers keep importing from one
 * place.
 */

/**
 * A sign-in provider: somewhere a fan can prove they control an account.
 *
 * The interface is deliberately two calls. `authorizeUrl` is where the fan is sent to
 * prove it; `exchange` is called once, on the callback, with the code that came back.
 * Nothing else may vouch for an identity: a request naming an external id proves nothing.
 */
export interface AuthorizeInput {
  state: string
  redirectUri: string
  /**
   * A hint for providers that let the caller pre-fill the account. The dev provider uses
   * it as the fake account to sign in as; real providers may ignore it. It is data for
   * the provider, never a credential.
   */
  loginHint?: string | undefined
}

export interface ExchangeInput {
  code: string
  redirectUri: string
}

/**
 * What a completed exchange proved.
 *
 * The profile is the identity itself. `verifiedActions` names the one-time proofs the
 * grant carried — Twitch's follow among them — and is empty for a provider that proves
 * nothing beyond the identity, such as the dev provider.
 */
export interface ExchangeResult {
  profile: IdentityProfile
  /** One-time actions this grant verified, e.g. ['twitch.follow']. */
  verifiedActions: string[]
  /** A grant to keep for later re-checks. Twitch's fan grant is not kept in this plan. */
  refreshToken?: string
}

export interface OAuthProvider {
  name: ProviderName
  authorizeUrl(input: AuthorizeInput): string
  exchange(input: ExchangeInput): Promise<ExchangeResult>
}

/**
 * The provider refused the code it was handed.
 *
 * A typed error so the callback can answer with a 4xx/5xx of its own instead of the
 * shared handler's 500, and can do it without creating a session or touching the ledger.
 */
export class ProviderExchangeError extends Error {
  readonly httpStatus: number

  constructor(message: string, httpStatus = 502) {
    super(message)
    this.name = 'ProviderExchangeError'
    this.httpStatus = httpStatus
  }
}
