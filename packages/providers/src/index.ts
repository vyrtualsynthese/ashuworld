export type ProviderName = 'twitch' | 'youtube' | 'discord' | 'dev'

export interface IdentityProfile {
  provider: ProviderName
  externalId: string
  displayHandle: string
  displayName: string
}

const PROVIDERS: readonly ProviderName[] = ['twitch', 'youtube', 'discord', 'dev']

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value)
}
