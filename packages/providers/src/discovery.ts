import { isProviderName, type ProviderName } from './names.js'

export interface DiscoveredPerson {
  provider: ProviderName
  externalId: string
  displayHandle: string
  displayName: string
  actions: string[]
}

export interface DiscoveryPayload extends DiscoveredPerson {
  kind: 'discovery'
}

export type DiscoverySource = 'sync' | 'signin'

function field(value: Record<string, unknown>, key: string): string {
  const raw = value[key]
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`discovery payload: "${key}" must be a non-empty string`)
  }
  return raw
}

/** Parses the queue payload, so a malformed event fails the attempt instead of awarding. */
export function parseDiscoveryPayload(value: unknown): DiscoveryPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('discovery payload: expected an object')
  }
  const record = value as Record<string, unknown>
  if (record['kind'] !== 'discovery') {
    throw new Error('discovery payload: "kind" must be "discovery"')
  }
  const provider = field(record, 'provider')
  if (!isProviderName(provider)) {
    throw new Error(`discovery payload: unknown provider ${JSON.stringify(provider)}`)
  }
  const actions = record['actions']
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error('discovery payload: "actions" must be a non-empty array')
  }
  return {
    kind: 'discovery',
    provider,
    externalId: field(record, 'externalId'),
    displayHandle: field(record, 'displayHandle'),
    displayName: field(record, 'displayName'),
    actions: actions.map((action) => {
      if (typeof action !== 'string' || action === '') {
        throw new Error('discovery payload: every action must be a non-empty string')
      }
      return action
    }),
  }
}

/**
 * The queue key for one fact about one person in one month. The month is part of it
 * because the fact is re-affirmed every month; `+` joins several actions so one event
 * still pays them together.
 */
export function discoveryEventId(
  source: DiscoverySource,
  person: Pick<DiscoveredPerson, 'provider' | 'externalId' | 'actions'>,
  month: string,
): string {
  return `${source}:${person.provider}:${person.externalId}:${person.actions.join('+')}:${month}`
}
