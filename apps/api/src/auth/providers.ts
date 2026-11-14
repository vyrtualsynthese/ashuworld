import { isProviderName, type ProviderName } from '@ashuworld/providers'
import type { Env } from '../config.js'
import { createTwitchProvider } from './providers/twitch.js'
import { ProviderExchangeError, type OAuthProvider } from './providers/types.js'

export * from './providers/types.js'

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
        profile: {
          provider: 'dev',
          externalId: `dev:${code}`,
          displayHandle: code,
          displayName: code,
        },
        verifiedActions: [],
      }
    },
  }
}

/** What the routes look a provider up in. Unknown names answer `undefined`. */
export interface ProviderRegistry {
  get(name: string): OAuthProvider | undefined
  /**
   * The configured provider names, in the order the capability route lists them.
   *
   * The order is a decision, not an accident of the map: it is what the sign-in page
   * renders, so it stays the same on every deployment and in every test run.
   */
  names(): ProviderName[]
}

/**
 * The fixed order the capability route lists providers in.
 *
 * Twitch leads because it is the platform the campaign runs on. `dev` is last and
 * conditional: it is a backdoor, and it must never look like the recommended door.
 */
const LISTED_PROVIDERS: readonly ProviderName[] = ['twitch', 'discord', 'youtube', 'dev']

/**
 * The environment the registry reads. A `Pick` rather than the whole `Env` so a test can
 * build a registry from three strings without inventing a database URL.
 */
export type ProviderEnv = Pick<
  Env,
  'ALLOW_DEV_LOGIN' | 'TWITCH_CLIENT_ID' | 'TWITCH_CLIENT_SECRET' | 'TWITCH_CHANNEL_LOGIN'
>

/**
 * Builds the configured providers.
 *
 * A provider is registered only when this deployment holds everything it needs: the dev
 * door behind `ALLOW_DEV_LOGIN`, Twitch behind its client pair and the channel the follow
 * is checked against. A name that is not registered answers `unknown_provider` rather than
 * pretending to work — the alternative is a fan who signs in and earns nothing, with no
 * hint why.
 *
 * `loadEnv` has already refused a half-set pair, so the checks here are about presence,
 * not about diagnosing a typo.
 */
export function createProviderRegistry(env: ProviderEnv): ProviderRegistry {
  const providers = new Map<ProviderName, OAuthProvider>()
  if (env.ALLOW_DEV_LOGIN) providers.set('dev', createDevProvider())

  const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_CHANNEL_LOGIN } = env
  if (
    TWITCH_CLIENT_ID !== undefined &&
    TWITCH_CLIENT_SECRET !== undefined &&
    TWITCH_CHANNEL_LOGIN !== undefined
  ) {
    providers.set(
      'twitch',
      createTwitchProvider({
        clientId: TWITCH_CLIENT_ID,
        clientSecret: TWITCH_CLIENT_SECRET,
        channelLogin: TWITCH_CHANNEL_LOGIN,
      }),
    )
  }

  return {
    get(name: string): OAuthProvider | undefined {
      if (!isProviderName(name)) return undefined
      return providers.get(name)
    },
    // Derived from `LISTED_PROVIDERS` rather than from the map's insertion order, so
    // configuring a provider in another order cannot reorder the page's buttons.
    names(): ProviderName[] {
      return LISTED_PROVIDERS.filter((name) => providers.has(name))
    },
  }
}
