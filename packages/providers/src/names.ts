export type ProviderName = 'twitch' | 'youtube' | 'discord' | 'dev'

export interface IdentityProfile {
  provider: ProviderName
  externalId: string
  displayHandle: string
  displayName: string
}

/**
 * Every provider this build accepts, in the order a message should list them.
 *
 * Exported so a refusal can name the same set `isProviderName` accepts instead of a
 * hand-written sentence that drifts the moment a provider is added.
 */
export const PROVIDER_NAMES: readonly ProviderName[] = ['twitch', 'youtube', 'discord', 'dev']

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value)
}
