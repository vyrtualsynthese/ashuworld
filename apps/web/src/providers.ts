/**
 * The provider names this app knows how to render, and their display labels.
 *
 * The names come from `@ashuworld/providers` so the web and the api cannot drift. That
 * package is pure names plus a discovery payload parser and imports no server code, so
 * the browser bundle can take it as it is.
 *
 * The app only ever *receives* a provider name in JSON, so the guard still matters here:
 * `?reattach=` carries a value the visitor controls, and an unknown one must be dropped
 * rather than rendered.
 */
import { isProviderName, type ProviderName } from '@ashuworld/providers'

export { isProviderName, type ProviderName }

const LABELS: Readonly<Record<ProviderName, string>> = {
  twitch: 'Twitch',
  youtube: 'YouTube',
  discord: 'Discord',
  dev: 'dev',
}

/** The real providers, in the order the account page offers them. */
export const LINKABLE_PROVIDERS: readonly ProviderName[] = ['twitch', 'youtube', 'discord']

/** A label for a provider that came from the api or from a URL. */
export function providerLabel(provider: string): string {
  return isProviderName(provider) ? LABELS[provider] : 'Plateforme inconnue'
}
