import type { DiscoveredPerson } from '@ashuworld/providers'
import type { Connector } from './types.js'

const TWITCH_EVERY_FIVE = 3 // 3 of every 5 people are Twitch: 60%

export function createStubConnector(people: number): Connector {
  return {
    name: 'stub',
    async *discover() {
      for (let index = 0; index < people; index += 1) {
        const number = String(index + 1).padStart(4, '0')
        const provider = index % 5 < TWITCH_EVERY_FIVE ? 'twitch' : 'discord'
        const suffix = provider === 'twitch' ? 'tv' : 'dc'
        yield {
          provider,
          externalId: `stub-${number}-${suffix}`,
          displayHandle: `stub${number}`,
          displayName: `Stub Dachi ${number}`,
          actions: [provider === 'twitch' ? 'twitch.follow' : 'discord.member'],
        } satisfies DiscoveredPerson
      }
    },
  }
}
