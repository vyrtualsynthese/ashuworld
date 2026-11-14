import { describe, expect, it } from 'vitest'
import { loadWorkerEnv } from '../src/config.js'

const base = { DATABASE_URL: 'postgres://x' }

describe('loadWorkerEnv', () => {
  it('defaults to no discovery and 250 people if ever enabled', () => {
    expect(loadWorkerEnv(base)).toEqual({
      DATABASE_URL: 'postgres://x',
      PLATFORM_CONNECTORS: [],
      ALLOW_STUB_CONNECTORS: false,
      STUB_PEOPLE: 250,
      SYNC_INTERVAL_SECONDS: 900,
    })
  })

  it('enables the stub only with both switches', () => {
    expect(
      loadWorkerEnv({ ...base, PLATFORM_CONNECTORS: 'stub', ALLOW_STUB_CONNECTORS: 'true' })
        .PLATFORM_CONNECTORS,
    ).toEqual(['stub'])
  })

  it('refuses the stub connector without its allow switch', () => {
    expect(() => loadWorkerEnv({ ...base, PLATFORM_CONNECTORS: 'stub' })).toThrow(
      /ALLOW_STUB_CONNECTORS/,
    )
  })

  it('refuses the allow switch without the stub connector', () => {
    expect(() => loadWorkerEnv({ ...base, ALLOW_STUB_CONNECTORS: 'true' })).toThrow(
      /PLATFORM_CONNECTORS/,
    )
  })

  it.each(['0', '5001', 'abc', '2.5', '1e3', '0x10'])('refuses STUB_PEOPLE=%s', (value) => {
    expect(() =>
      loadWorkerEnv({
        ...base,
        PLATFORM_CONNECTORS: 'stub',
        ALLOW_STUB_CONNECTORS: 'true',
        STUB_PEOPLE: value,
      }),
    ).toThrow(/STUB_PEOPLE/)
  })

  it.each(['0', '31536001', 'abc', '2.5', '1e3', '0x10'])(
    'refuses SYNC_INTERVAL_SECONDS=%s',
    (value) => {
      expect(() => loadWorkerEnv({ ...base, SYNC_INTERVAL_SECONDS: value })).toThrow(
        /SYNC_INTERVAL_SECONDS/,
      )
    },
  )

  it('accepts 900 seconds and the interval boundaries', () => {
    const load = (seconds: string) =>
      loadWorkerEnv({ ...base, SYNC_INTERVAL_SECONDS: seconds }).SYNC_INTERVAL_SECONDS
    expect(load('900')).toBe(900)
    expect(load('1')).toBe(1)
    expect(load('31536000')).toBe(31_536_000)
  })

  it('accepts the boundaries', () => {
    const load = (people: string) =>
      loadWorkerEnv({
        ...base,
        PLATFORM_CONNECTORS: 'stub',
        ALLOW_STUB_CONNECTORS: 'true',
        STUB_PEOPLE: people,
      }).STUB_PEOPLE
    expect(load('1')).toBe(1)
    expect(load('5000')).toBe(5000)
  })

  it('refuses an unknown connector, a bad interval and a missing database url', () => {
    expect(() => loadWorkerEnv({ ...base, PLATFORM_CONNECTORS: 'twitch' })).toThrow(
      /PLATFORM_CONNECTORS/,
    )
    expect(() => loadWorkerEnv({ ...base, SYNC_INTERVAL_SECONDS: '0' })).toThrow(
      /SYNC_INTERVAL_SECONDS/,
    )
    expect(() => loadWorkerEnv({})).toThrow(/DATABASE_URL/)
  })
})
