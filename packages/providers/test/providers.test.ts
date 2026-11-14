import { describe, expect, it } from 'vitest'
import { isProviderName, type IdentityProfile } from '../src/index.js'

describe('provider types', () => {
  it('accepts the four alpha providers and rejects others', () => {
    expect(isProviderName('twitch')).toBe(true)
    expect(isProviderName('dev')).toBe(true)
    expect(isProviderName('myspace')).toBe(false)
  })

  it('keeps the identity profile shape', () => {
    const p: IdentityProfile = { provider: 'twitch', externalId: '1', displayHandle: 'ashu', displayName: 'Ashu' }
    expect(p.provider).toBe('twitch')
  })
})
