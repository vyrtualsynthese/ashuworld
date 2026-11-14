import { isProviderName, type IdentityProfile, type ProviderName } from '@ashuworld/providers'
import type { Env } from '../config.js'

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

export interface OAuthProvider {
  name: ProviderName
  authorizeUrl(input: AuthorizeInput): string
  exchange(input: ExchangeInput): Promise<IdentityProfile>
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

/** The fake account the dev door signs in as when the start request names none. */
export const DEV_DEFAULT_HANDLE = 'ashu'

/**
 * The dev code becomes an external id and a display handle, so it is bounded and kept to
 * characters that survive both. It never reaches a URL unencoded: `authorizeUrl` builds
 * its query with `URLSearchParams`.
 */
const DEV_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/

/**
 * The development provider: a door that verifies nothing and says so.
 *
 * It exists so the whole handshake, fan resolution and cookie path can be exercised
 * before any real OAuth application exists. It is registered only when
 * `ALLOW_DEV_LOGIN` is true, and its external id is namespaced `dev:` so it can never
 * collide with an id a real provider will one day return.
 */
export function createDevProvider(): OAuthProvider {
  return {
    name: 'dev',
    authorizeUrl({ state, redirectUri, loginHint }) {
      const url = new URL(redirectUri)
      url.searchParams.set('code', loginHint ?? DEV_DEFAULT_HANDLE)
      url.searchParams.set('state', state)
      return url.toString()
    },
    async exchange({ code }) {
      if (!DEV_CODE_PATTERN.test(code)) {
        throw new ProviderExchangeError(
          'the dev login code must be 1 to 64 letters, digits, dots, dashes or underscores',
          400,
        )
      }
      return {
        provider: 'dev',
        externalId: `dev:${code}`,
        displayHandle: code,
        displayName: code,
      }
    },
  }
}

/** What the routes look a provider up in. Unknown names answer `undefined`. */
export interface ProviderRegistry {
  get(name: string): OAuthProvider | undefined
}

/**
 * Builds the configured providers.
 *
 * Twitch, YouTube and Discord need OAuth applications and secrets, so they are not
 * registered yet: a login attempt answers `unknown_provider` rather than pretending to
 * work. The dev provider is the only one that can be switched on from the environment.
 */
export function createProviderRegistry(env: Pick<Env, 'ALLOW_DEV_LOGIN'>): ProviderRegistry {
  const providers = new Map<ProviderName, OAuthProvider>()
  if (env.ALLOW_DEV_LOGIN) providers.set('dev', createDevProvider())

  return {
    get(name: string): OAuthProvider | undefined {
      if (!isProviderName(name)) return undefined
      return providers.get(name)
    },
  }
}
