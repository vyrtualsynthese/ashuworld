import { describe, expect, it } from 'vitest'
import { isProviderName, type IdentityProfile } from '../src/index.js'

describe('provider types', () => {
  it('accepts the four alpha providers and rejects others', () => {
    expect(isProviderName('twitch')).toBe(true)
    expect(isProviderName('youtube')).toBe(true)
    expect(isProviderName('discord')).toBe(true)
    expect(isProviderName('dev')).toBe(true)
    expect(isProviderName('myspace')).toBe(false)
    // The list is case-sensitive: a capitalised platform name is not a provider.
    expect(isProviderName('Twitch')).toBe(false)
  })

  it('rejects empty input and trailing whitespace from platform callbacks', () => {
    expect(isProviderName('')).toBe(false)
    expect(isProviderName('twitch ')).toBe(false)
  })

  it('keeps the identity profile shape', () => {
    const p: IdentityProfile = { provider: 'twitch', externalId: '1', displayHandle: 'ashu', displayName: 'Ashu' }
    // The guard accepts a provider read off the profile, tying the type to the runtime list.
    expect(isProviderName(p.provider)).toBe(true)
  })
})
