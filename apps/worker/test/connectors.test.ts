import { describe, expect, it } from 'vitest'
import { loadWorkerEnv } from '../src/config.js'
import { createConnectors } from '../src/connectors/index.js'
import { createStubConnector } from '../src/connectors/stub.js'

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

    const connectors = createConnectors(env)
    expect(connectors).toHaveLength(1)
    const connector = connectors[0]
    if (connector === undefined) throw new Error('expected one connector')
    expect(connector.name).toBe('stub')

    const people = []
    for await (const person of connector.discover()) people.push(person)
    expect(people).toHaveLength(5)
  })

  it('builds nothing when the environment names no connector', () => {
    expect(createConnectors(loadWorkerEnv({ DATABASE_URL: 'postgres://x' }))).toEqual([])
  })
})
