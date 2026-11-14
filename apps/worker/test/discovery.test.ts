import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import type { DiscoveredPerson } from '@ashuworld/providers'
import type { Connector } from '../src/connectors/types.js'
import { createDiscoveryEnqueue, runDiscovery } from '../src/discovery.js'

/** A person the runner only reads `externalId` from in these tests. */
function person(externalId: string): DiscoveredPerson {
  return {
    provider: 'twitch',
    externalId,
    displayHandle: externalId,
    displayName: externalId,
    actions: ['twitch.follow'],
  }
}

/**
 * The name is only a label for the logs, and `stub` is the only connector that exists in
 * the config today, so the helper accepts any label and casts it.
 */
function connector(name: string, ids: string[]): Connector {
  return {
    name: name as Connector['name'],
    async *discover() {
      for (const id of ids) yield person(id)
    },
  }
}

/** Fails on the first read, before yielding anything. */
function brokenConnector(): Connector {
  return {
    name: 'broken' as Connector['name'],
    discover() {
      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<DiscoveredPerson>> => {
            throw new Error('the source is down')
          },
        }),
      }
    },
  }
}

describe('runDiscovery', () => {
  it('enqueues every person from every connector, then waits and runs again', async () => {
    const seen: string[] = []
    let rounds = 0
    const controller = new AbortController()
    await runDiscovery({
      connectors: [connector('a', ['x', 'y']), connector('b', ['z'])],
      enqueue: async (person) => {
        seen.push(person.externalId)
      },
      intervalMs: 5,
      signal: controller.signal,
      // The runner hands the wait an AbortSignal, which has no `abort()`; the controller is
      // what fires it, so the test closes over that (as the drain loop's tests do).
      wait: async () => {
        rounds += 1
        if (rounds === 2) controller.abort()
      },
    })
    expect(seen).toEqual(['x', 'y', 'z', 'x', 'y', 'z'])
  })

  it('keeps the other connectors running when one throws', async () => {
    const seen: string[] = []
    const controller = new AbortController()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await runDiscovery({
        connectors: [brokenConnector(), connector('b', ['z'])],
        enqueue: async (person) => {
          seen.push(person.externalId)
        },
        intervalMs: 5,
        signal: controller.signal,
        wait: async () => controller.abort(),
      })
      expect(seen).toEqual(['z'])
      // The failed source is named, so the operator can tell which one to look at.
      expect(errorLog).toHaveBeenCalledTimes(1)
      expect(String(errorLog.mock.calls[0]?.[0])).toContain('connector "broken" failed')
    } finally {
      errorLog.mockRestore()
    }
  })

  it('logs a failed enqueue on its own line and keeps the round going', async () => {
    const seen: string[] = []
    const controller = new AbortController()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await runDiscovery({
        connectors: [connector('a', ['x', 'y'])],
        enqueue: async (person) => {
          if (person.externalId === 'x') throw new Error('the queue is unreachable')
          seen.push(person.externalId)
        },
        intervalMs: 5,
        signal: controller.signal,
        wait: async () => controller.abort(),
      })

      // The person after the failure is still enqueued, and the failure is not blamed
      // on the connector: the source worked, the queue write did not.
      expect(seen).toEqual(['y'])
      expect(errorLog).toHaveBeenCalledTimes(1)
      const logged = String(errorLog.mock.calls[0]?.[0])
      expect(logged).toContain('discovery enqueue failed')
      expect(logged).not.toContain('connector "')
    } finally {
      errorLog.mockRestore()
    }
  })

  it('stops without enqueuing when the signal is already aborted', async () => {
    const seen: string[] = []
    await runDiscovery({
      connectors: [connector('a', ['x'])],
      enqueue: async (p) => {
        seen.push(p.externalId)
      },
      intervalMs: 5,
      signal: AbortSignal.abort(),
    })
    expect(seen).toEqual([])
  })

  it('returns at once when there is nothing to discover, without waiting or enqueuing', async () => {
    const enqueue = vi.fn(async () => undefined)
    const wait = vi.fn(async () => undefined)

    await runDiscovery({ connectors: [], enqueue, intervalMs: 30_000, wait })

    expect(wait).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('ends an idle wait as soon as the signal fires, without waiting out the interval', async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20)
    const started = Date.now()
    try {
      // The real timer path: the runner is asleep in the default wait when the signal
      // lands, and the abort listener, not the 30-second interval, is what ends it.
      await runDiscovery({
        connectors: [connector('a', [])],
        enqueue: async () => undefined,
        intervalMs: 30_000,
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    expect(controller.signal.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('createDiscoveryEnqueue', () => {
  let db: TestDb
  let pool: Pool

  beforeAll(async () => {
    db = await createTestDb()
    pool = db.pool
  })

  beforeEach(async () => {
    await db.reset()
  })

  afterAll(async () => {
    await pool.end()
  })

  it('queues one month-keyed sync event carrying the person', async () => {
    const enqueue = createDiscoveryEnqueue(pool, () => new Date('2026-11-14T12:00:00Z'))
    const discovered = person('t-1')

    await enqueue(discovered)

    const { rows } = await pool.query<{ provider: string; event_id: string; payload: unknown }>(
      'select provider, event_id, payload from inbound_events',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'twitch',
      // The whole key format, including the month and the joined actions, is the
      // idempotency of discovery: a change here would queue a second event every round.
      event_id: 'sync:twitch:t-1:twitch.follow:2026-11',
      payload: { kind: 'discovery', ...discovered },
    })
  })
})
