/**
 * The provider names this app knows how to render, and their display labels.
 *
 * The list mirrors `ProviderName` in `packages/providers`. It is written here rather than
 * imported for one reason: the browser bundle would otherwise pull in the server package,
 * whose dev provider is built to run behind the api. The app only ever *receives* a
 * provider name in JSON, so a local guard is what it needs anyway: `?reattach=` carries a
 * value the visitor controls, and an unknown one must be dropped rather than rendered.
 */
export const PROVIDERS = ['twitch', 'youtube', 'discord', 'dev'] as const

export type ProviderName = (typeof PROVIDERS)[number]

const LABELS: Readonly<Record<ProviderName, string>> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  discord: 'Discord',
  dev: 'dev',
}

/** The real providers, in the order the account page offers them. */
export const LINKABLE_PROVIDERS: readonly ProviderName[] = ['twitch', 'youtube', 'discord']

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value)
}

/** A label for a provider that came from the api or from a URL. */
export function providerLabel(provider: string): string {
  return isProviderName(provider) ? LABELS[provider] : provider
}
