import type { DiscoveredPerson } from '@ashuworld/providers'
import type { ConnectorName } from '../config.js'

/** A source the operator can enumerate. The stub is the first; Twitch and Discord follow. */
export interface Connector {
  name: ConnectorName
  discover(): AsyncIterable<DiscoveredPerson>
}
