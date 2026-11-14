import { describe, expect, it } from 'vitest'
import { createProviderRegistry } from '../../src/auth/providers.js'

describe('createProviderRegistry', () => {
  it('registers Twitch only when its credentials and channel are present', () => {
    expect(createProviderRegistry({ ALLOW_DEV_LOGIN: false }).get('twitch')).toBeUndefined()

    const partial = createProviderRegistry({
      ALLOW_DEV_LOGIN: false,
      TWITCH_CLIENT_ID: 'cid',
      TWITCH_CLIENT_SECRET: 's',
    })
    expect(partial.get('twitch')).toBeUndefined()

    const registry = createProviderRegistry({
      ALLOW_DEV_LOGIN: false,
      TWITCH_CLIENT_ID: 'cid',
      TWITCH_CLIENT_SECRET: 's',
      TWITCH_CHANNEL_LOGIN: 'ashuworld',
    })
    expect(registry.get('twitch')?.name).toBe('twitch')
  })

  it('keeps the dev door behind its switch', () => {
    expect(createProviderRegistry({ ALLOW_DEV_LOGIN: false }).get('dev')).toBeUndefined()
    expect(createProviderRegistry({ ALLOW_DEV_LOGIN: true }).get('dev')?.name).toBe('dev')
  })

  it('answers undefined for a name no provider has', () => {
    const registry = createProviderRegistry({
      ALLOW_DEV_LOGIN: true,
      TWITCH_CLIENT_ID: 'cid',
      TWITCH_CLIENT_SECRET: 's',
      TWITCH_CHANNEL_LOGIN: 'ashuworld',
    })
    expect(registry.get('youtube')).toBeUndefined()
    expect(registry.get('nonsense')).toBeUndefined()
  })
})
