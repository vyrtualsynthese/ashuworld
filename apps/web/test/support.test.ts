import { describe, expect, it } from 'vitest'
import { devLoginAvailable } from '../src/devLogin'
import { isProviderName, providerLabel } from '../src/providers'
import { formatNumber } from '../src/format'

describe('devLoginAvailable', () => {
  it('offers the door in a dev build when nothing says otherwise', () => {
    expect(devLoginAvailable({ DEV: true })).toBe(true)
  })

  it('keeps the door shut in a production build', () => {
    expect(devLoginAvailable({ DEV: false })).toBe(false)
  })

  it('lets the build flag hide the door in a dev build', () => {
    expect(devLoginAvailable({ DEV: true, VITE_DEV_LOGIN: 'false' })).toBe(false)
  })

  it('lets the build flag offer the door in a production build', () => {
    expect(devLoginAvailable({ DEV: false, VITE_DEV_LOGIN: 'true' })).toBe(true)
  })
})

describe('providers', () => {
  it('only accepts the four provider names the api can send', () => {
    expect(isProviderName('twitch')).toBe(true)
    expect(isProviderName('dev')).toBe(true)
    expect(isProviderName('Twitch')).toBe(false)
    expect(isProviderName('<script>')).toBe(false)
  })

  it('labels the known providers and passes an unknown one through only for display', () => {
    expect(providerLabel('youtube')).toBe('YouTube')
    expect(providerLabel('twitch')).toBe('Twitch')
    expect(providerLabel('mystery')).toBe('mystery')
  })
})

describe('formatNumber', () => {
  it('groups thousands so a big balance stays readable', () => {
    expect(formatNumber(320)).toBe('320')
    expect(formatNumber(1240)).toBe('1,240')
  })
})
