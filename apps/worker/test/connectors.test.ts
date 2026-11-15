import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { loadWorkerEnv } from '../src/config.js'
import { createConnectors } from '../src/connectors/index.js'
import { createStubConnector } from '../src/connectors/stub.js'

/**
 * The stub never reads the pool, but the factory takes one because the Twitch connector
 * does. A test that builds only sources which ignore it should not need a database.
 */
const unusedPool = {} as Pool

/** A valid key for `PLATFORM_TOKEN_KEY`: the config checks it is 32 bytes, not its value. */
const tokenKey = randomBytes(32).toString('base64')

async function collect(people: number) {
  const out = []
  for await (const person of createStubConnector(people).discover()) out.push(person)
  return out
}

describe('createStubConnector', () => {
  it('yields exactly the requested number of people', async () => {
    expect(await collect(7)).toHaveLength(7)
    expect(await collect(1)).toHaveLength(1)
  })

  it('is deterministic', async () => {
    expect(await collect(10)).toEqual(await collect(10))
  })

  it('splits 60% Twitch and 40% Discord rounds down', async () => {
    const people = await collect(10)
    expect(people.filter((p) => p.provider === 'twitch')).toHaveLength(6)
    expect(people.filter((p) => p.provider === 'discord')).toHaveLength(4)
    expect(people[0]?.actions).toEqual(['twitch.follow'])
    expect(people[9]?.actions).toEqual(['discord.member'])
  })

  it('keeps external ids unique and prefixed', async () => {
    const people = await collect(50)
    expect(new Set(people.map((p) => p.externalId)).size).toBe(50)
    expect(people.every((p) => p.externalId.startsWith('stub-'))).toBe(true)
  })
})

describe('createConnectors', () => {
  /**
   * The env is built by `loadWorkerEnv`, not hand-written, so this also pins the wiring
   * from the raw variables to the connector the process actually runs.
   */
  it('builds the stub the environment names and hands it STUB_PEOPLE', async () => {
    const env = loadWorkerEnv({
      DATABASE_URL: 'postgres://x',
      PLATFORM_CONNECTORS: 'stub',
      ALLOW_STUB_CONNECTORS: 'true',
      STUB_PEOPLE: '5',
    })

    const connectors = createConnectors(env, unusedPool)
    expect(connectors).toHaveLength(1)
    const connector = connectors[0]
    if (connector === undefined) throw new Error('expected one connector')
    expect(connector.name).toBe('stub')

    const people = []
    for await (const person of connector.discover()) people.push(person)
    expect(people).toHaveLength(5)
  })

  it('builds the Twitch connector when the environment names it', () => {
    const env = loadWorkerEnv({
      DATABASE_URL: 'postgres://x',
      PLATFORM_CONNECTORS: 'twitch',
      TWITCH_CLIENT_ID: 'id',
      TWITCH_CLIENT_SECRET: 'secret',
      TWITCH_CHANNEL_LOGIN: 'channel',
      TWITCH_CHANNEL_REFRESH_TOKEN: 'refresh',
      PLATFORM_TOKEN_KEY: tokenKey,
    })

    // Building it must not touch the network; the first discovery round is what refreshes.
    expect(createConnectors(env, unusedPool).map((connector) => connector.name)).toEqual(['twitch'])
  })

  it('builds every named connector in the order the environment lists them', () => {
    const env = loadWorkerEnv({
      DATABASE_URL: 'postgres://x',
      PLATFORM_CONNECTORS: 'twitch,stub',
      ALLOW_STUB_CONNECTORS: 'true',
      STUB_PEOPLE: '2',
      TWITCH_CLIENT_ID: 'id',
      TWITCH_CLIENT_SECRET: 'secret',
      TWITCH_CHANNEL_LOGIN: 'channel',
      TWITCH_CHANNEL_REFRESH_TOKEN: 'refresh',
      PLATFORM_TOKEN_KEY: tokenKey,
    })

    expect(createConnectors(env, unusedPool).map((connector) => connector.name)).toEqual([
      'twitch',
      'stub',
    ])
  })

  it('builds nothing when the environment names no connector', () => {
    expect(createConnectors(loadWorkerEnv({ DATABASE_URL: 'postgres://x' }), unusedPool)).toEqual([])
  })
})
