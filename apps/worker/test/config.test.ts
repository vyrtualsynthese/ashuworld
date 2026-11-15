import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadWorkerEnv } from '../src/config.js'

const base = { DATABASE_URL: 'postgres://x' }

/** A fresh key every call: the tests never share a secret, even a throwaway one. */
const tokenKey = () => randomBytes(32).toString('base64')

/** Everything Twitch needs, so a test can delete exactly one field and nothing else. */
const twitch = () => ({
  TWITCH_CLIENT_ID: 'client-id-value',
  TWITCH_CLIENT_SECRET: 'client-secret-value',
  TWITCH_CHANNEL_LOGIN: 'ashuworld',
  TWITCH_CHANNEL_REFRESH_TOKEN: 'refresh-token-value',
  PLATFORM_TOKEN_KEY: tokenKey(),
})

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
    expect(() => loadWorkerEnv({ ...base, PLATFORM_CONNECTORS: 'nope' })).toThrow(
      /PLATFORM_CONNECTORS/,
    )
    expect(() => loadWorkerEnv({ ...base, SYNC_INTERVAL_SECONDS: '0' })).toThrow(
      /SYNC_INTERVAL_SECONDS/,
    )
    expect(() => loadWorkerEnv({})).toThrow(/DATABASE_URL/)
  })
})

describe('loadWorkerEnv twitch settings', () => {
  it('accepts twitch when all five values are present', () => {
    const env = loadWorkerEnv({ ...base, ...twitch(), PLATFORM_CONNECTORS: 'twitch' })
    expect(env.PLATFORM_CONNECTORS).toEqual(['twitch'])
    expect(env.TWITCH_CLIENT_ID).toBe('client-id-value')
    expect(env.TWITCH_CHANNEL_LOGIN).toBe('ashuworld')
    expect(env.TWITCH_CHANNEL_REFRESH_TOKEN).toBe('refresh-token-value')
    expect(env.PLATFORM_TOKEN_KEY).toBeDefined()
  })

  it.each([
    'TWITCH_CLIENT_ID',
    'TWITCH_CLIENT_SECRET',
    'TWITCH_CHANNEL_LOGIN',
    'TWITCH_CHANNEL_REFRESH_TOKEN',
    'PLATFORM_TOKEN_KEY',
  ])('refuses twitch without %s', (missing) => {
    const env: Record<string, string> = { ...base, ...twitch(), PLATFORM_CONNECTORS: 'twitch' }
    delete env[missing]
    expect(() => loadWorkerEnv(env)).toThrow(new RegExp(missing))
  })

  it('refuses the Twitch pair half-set even when twitch is not listed', () => {
    expect(() => loadWorkerEnv({ ...base, TWITCH_CLIENT_ID: 'c' })).toThrow(/TWITCH_CLIENT_SECRET/)
    expect(() => loadWorkerEnv({ ...base, TWITCH_CLIENT_SECRET: 's' })).toThrow(/TWITCH_CLIENT_ID/)
  })

  it('refuses twitch listed with no Twitch value at all, naming both halves of the pair', () => {
    expect(() => loadWorkerEnv({ ...base, PLATFORM_CONNECTORS: 'twitch' })).toThrow(
      /PLATFORM_CONNECTORS lists "twitch" but TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET/,
    )
  })

  it('treats a blank TWITCH_CHANNEL_LOGIN as absent, so the error names it', () => {
    expect(() =>
      loadWorkerEnv({
        ...base,
        ...twitch(),
        TWITCH_CHANNEL_LOGIN: '   ',
        PLATFORM_CONNECTORS: 'twitch',
      }),
    ).toThrow(/TWITCH_CHANNEL_LOGIN/)
  })

  it('accepts a complete set without twitch listed, and leaves it unused', () => {
    const env = loadWorkerEnv({ ...base, ...twitch() })
    expect(env.PLATFORM_CONNECTORS).toEqual([])
    expect(env.TWITCH_CLIENT_ID).toBe('client-id-value')
  })

  it('leaves every Twitch field absent when nothing is set', () => {
    const env = loadWorkerEnv(base)
    expect(Object.keys(env)).not.toContain('TWITCH_CLIENT_ID')
    expect(Object.keys(env)).not.toContain('TWITCH_CLIENT_SECRET')
    expect(Object.keys(env)).not.toContain('TWITCH_CHANNEL_LOGIN')
    expect(Object.keys(env)).not.toContain('TWITCH_CHANNEL_REFRESH_TOKEN')
    expect(Object.keys(env)).not.toContain('PLATFORM_TOKEN_KEY')
  })

  it.each([
    ['31 bytes', () => randomBytes(31).toString('base64')],
    ['33 bytes', () => randomBytes(33).toString('base64')],
    ['not base64', () => 'not-a-key-at-all'],
  ])('refuses a PLATFORM_TOKEN_KEY that is %s', (_label, make) => {
    expect(() =>
      loadWorkerEnv({ ...base, ...twitch(), PLATFORM_TOKEN_KEY: make(), PLATFORM_CONNECTORS: 'twitch' }),
    ).toThrow(/PLATFORM_TOKEN_KEY.*32 bytes/)
  })

  it('refuses a bad PLATFORM_TOKEN_KEY even when twitch is not listed', () => {
    expect(() => loadWorkerEnv({ ...base, PLATFORM_TOKEN_KEY: 'short' })).toThrow(
      /PLATFORM_TOKEN_KEY/,
    )
  })

  it('never echoes a credential in a startup error', () => {
    const error = (() => {
      try {
        loadWorkerEnv({ ...base, TWITCH_CLIENT_SECRET: 'super-secret-value' })
        return undefined
      } catch (caught) {
        return caught as Error
      }
    })()
    expect(error?.message).toMatch(/TWITCH_CLIENT_ID/)
    expect(error?.message).not.toContain('super-secret-value')
  })
})
