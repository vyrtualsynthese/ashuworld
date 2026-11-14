import { describe, expect, it } from 'vitest'
import { discoveryEventId, parseDiscoveryPayload } from '../src/discovery.js'

const person = {
  provider: 'twitch' as const,
  externalId: 't-1',
  displayHandle: 'ashu',
  displayName: 'Ashu',
  actions: ['twitch.follow'],
}

describe('parseDiscoveryPayload', () => {
  it('accepts a well-formed discovery payload', () => {
    expect(parseDiscoveryPayload({ kind: 'discovery', ...person })).toEqual({
      kind: 'discovery',
      ...person,
    })
  })

  it.each([
    ['not an object', 'nope'],
    ['wrong kind', { ...person, kind: 'follow' }],
    ['unknown provider', { kind: 'discovery', ...person, provider: 'myspace' }],
    ['empty handle', { kind: 'discovery', ...person, displayHandle: '' }],
    ['no actions', { kind: 'discovery', ...person, actions: [] }],
    ['non-string action', { kind: 'discovery', ...person, actions: [1] }],
  ])('refuses %s', (_label, value) => {
    expect(() => parseDiscoveryPayload(value)).toThrow()
  })
})

describe('discoveryEventId', () => {
  it('is stable for one person, source and month', () => {
    const id = discoveryEventId('sync', person, '2026-11')
    expect(id).toBe('sync:twitch:t-1:twitch.follow:2026-11')
    expect(discoveryEventId('sync', person, '2026-11')).toBe(id)
  })

  it('separates sign-in from discovery and one month from the next', () => {
    expect(discoveryEventId('signin', person, '2026-11')).not.toBe(
      discoveryEventId('sync', person, '2026-11'),
    )
    expect(discoveryEventId('sync', person, '2026-12')).not.toBe(
      discoveryEventId('sync', person, '2026-11'),
    )
  })
})
