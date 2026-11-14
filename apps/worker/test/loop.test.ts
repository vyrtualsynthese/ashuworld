import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { createTestDb, type TestDb } from '@ashuworld/ledger/testing'
import { processOne, runLoop } from '../src/loop.js'
import { requireProcessor, type Processor, type ProcessorMap } from '../src/processors.js'

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
  await db.pool.end()
})

function first<T>(rows: T[]): T {
  const row = rows[0]
  if (row === undefined) throw new Error('expected the query to return a row')
  return row
}

async function insertEvent(
  provider: string,
  eventId: string,
  payload: unknown = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into inbound_events (provider, event_id, payload) values ($1, $2, $3) returning id`,
    [provider, eventId, JSON.stringify(payload)],
  )
  return first(rows).id
}

interface StoredEvent {
  processed_at: Date | null
  attempts: number
  payload: unknown
}

async function storedEvent(id: string): Promise<StoredEvent> {
  const { rows } = await pool.query<StoredEvent>(
    'select processed_at, attempts, payload from inbound_events where id = $1',
    [id],
  )
  return first(rows)
}

/** Rows the test processors leave behind; rolled back with their transaction when they throw. */
async function markerCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from audit_log where kind = 'test.marker'`,
  )
  return first(rows).n
}

async function markerPayloads(): Promise<unknown[]> {
  const { rows } = await pool.query<{ detail: unknown }>(
    `select detail from audit_log where kind = 'test.marker' order by id`,
  )
  return rows.map((row) => row.detail)
}

function insertMarker(): Processor {
  return async (tx, payload) => {
    await tx.query(`insert into audit_log (kind, detail) values ('test.marker', $1)`, [
      JSON.stringify(payload),
    ])
  }
}

/** A processor map with one working `twitch` processor that records what it was given. */
function twitchProcessor(seen: unknown[] = []): ProcessorMap {
  return new Map([
    [
      'twitch' as const,
      async (tx, payload) => {
        seen.push(payload)
        await insertMarker()(tx, payload)
      },
    ],
  ])
}

/**
 * Resolves with the promise, or with `'slow'` once `ms` passes. Used to prove that a second
 * worker does not wait on a lock held by the first: a sequential implementation trips the
 * deadline instead of hanging the suite.
 */
async function within<T>(run: Promise<T>, ms: number): Promise<T | 'slow'> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'slow'>((resolve) => {
    timer = setTimeout(() => resolve('slow'), ms)
  })
  try {
    return await Promise.race([run, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('processOne', () => {
  it('processes an event and marks it processed', async () => {
    const id = await insertEvent('twitch', 'follow-1', { type: 'follow', user: 'ada' })
    const seen: unknown[] = []

    await expect(processOne(pool, twitchProcessor(seen))).resolves.toBe('processed')

    expect(seen).toEqual([{ type: 'follow', user: 'ada' }])
    const row = await storedEvent(id)
    expect(row.processed_at).not.toBeNull()
    expect(row.attempts).toBe(0)
    expect(await markerCount()).toBe(1)
  })

  it('returns empty when there is nothing to do', async () => {
    await expect(processOne(pool, twitchProcessor())).resolves.toBe('empty')
  })

  it('leaves the row unprocessed when the processor throws, and retries it', async () => {
    const id = await insertEvent('twitch', 'follow-2', { type: 'follow' })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const failing: ProcessorMap = new Map([
        [
          'twitch' as const,
          async (tx, payload) => {
            await insertMarker()(tx, payload)
            throw new Error('the processor exploded')
          },
        ],
      ])

      await expect(processOne(pool, failing)).resolves.toBe('empty')

      const failed = await storedEvent(id)
      expect(failed.processed_at).toBeNull()
      expect(failed.attempts).toBe(1)
      // The marker was written inside the processor's transaction: rolling back is what
      // keeps a retry from paying the same event twice.
      expect(await markerCount()).toBe(0)

      expect(errorLog).toHaveBeenCalledTimes(1)
      const message = String(errorLog.mock.calls[0]?.[0])
      expect(message).toContain(`#${id}`)
      expect(message).toContain('follow-2')
      expect(message).toContain('attempt 1')
      expect(errorLog.mock.calls[0]?.[1]).toBeInstanceOf(Error)

      // The retry sees the same row, runs the processor again and succeeds.
      await expect(processOne(pool, twitchProcessor())).resolves.toBe('processed')
      const retried = await storedEvent(id)
      expect(retried.processed_at).not.toBeNull()
      expect(retried.attempts).toBe(1)
      expect(retried.payload).toEqual({ type: 'follow' })
      expect(await markerCount()).toBe(1)
    } finally {
      errorLog.mockRestore()
    }
  })

  it('counts every attempt and keeps retrying past five, logging the id each time', async () => {
    const id = await insertEvent('twitch', 'follow-3', {})
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      const failing: ProcessorMap = new Map([
        [
          'twitch' as const,
          async () => {
            throw new Error('still broken')
          },
        ],
      ])

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await expect(processOne(pool, failing)).resolves.toBe('empty')
      }

      const row = await storedEvent(id)
      expect(row.attempts).toBe(5)
      expect(row.processed_at).toBeNull()

      expect(errorLog).toHaveBeenCalledTimes(5)
      for (const [index, call] of errorLog.mock.calls.entries()) {
        const message = String(call[0])
        expect(message).toContain(`#${id}`)
        expect(message).toContain(`attempt ${index + 1}`)
      }

      // No dead-letter table at alpha: the row is still the oldest claimable event.
      await expect(processOne(pool, failing)).resolves.toBe('empty')
      expect((await storedEvent(id)).attempts).toBe(6)
    } finally {
      errorLog.mockRestore()
    }
  })

  it('does not process the same row twice with two concurrent workers', async () => {
    const id = await insertEvent('twitch', 'follow-4', { n: 1 })
    let entered: () => void = () => undefined
    const enteredClaim = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const seen: unknown[] = []
    const processors: ProcessorMap = new Map([
      [
        'twitch' as const,
        async (tx, payload) => {
          seen.push(payload)
          entered()
          await gate
          await insertMarker()(tx, payload)
        },
      ],
    ])

    const firstWorker = processOne(pool, processors)
    await enteredClaim

    try {
      // The first worker holds the row's lock and is inside its processor. The second
      // worker must not double-process it: `skip locked` sends it away.
      const second = await within(processOne(pool, processors), 2_000)
      expect(second).toBe('empty')
    } finally {
      release()
    }

    await expect(firstWorker).resolves.toBe('processed')
    expect(seen).toHaveLength(1)
    expect(await markerCount()).toBe(1)
    expect((await storedEvent(id)).processed_at).not.toBeNull()
  })

  it('lets a second worker claim the next row while the first is still running', async () => {
    await insertEvent('twitch', 'first', { n: 1 })
    await insertEvent('twitch', 'second', { n: 2 })
    let entered: () => void = () => undefined
    const enteredClaim = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    let calls = 0
    const processors: ProcessorMap = new Map([
      [
        'twitch' as const,
        async (tx, payload) => {
          calls += 1
          if (calls === 1) {
            entered()
            await gate
          }
          await insertMarker()(tx, payload)
        },
      ],
    ])

    const firstWorker = processOne(pool, processors)
    await enteredClaim

    try {
      const second = await within(processOne(pool, processors), 2_000)
      expect(second).toBe('processed')
      // Only the second row has been paid while the first transaction is still open.
      expect(await markerPayloads()).toEqual([{ n: 2 }])
    } finally {
      release()
    }

    await expect(firstWorker).resolves.toBe('processed')
    expect(calls).toBe(2)
    expect((await markerPayloads()).length).toBe(2)
  })

  it('leaves a provider with no processor alone instead of burning its attempts', async () => {
    const unrouted = await insertEvent('youtube', 'subscribe-1', {})
    const routed = await insertEvent('twitch', 'follow-5', {})

    await expect(processOne(pool, twitchProcessor())).resolves.toBe('processed')

    // The unrouted row is older than the routed one, so a claim that did not filter by
    // provider would have blocked the queue on it.
    const untouched = await storedEvent(unrouted)
    expect(untouched.processed_at).toBeNull()
    expect(untouched.attempts).toBe(0)
    expect((await storedEvent(routed)).processed_at).not.toBeNull()
  })
})

describe('requireProcessor', () => {
  it('names the provider when the map has no processor for it', () => {
    expect(() => requireProcessor(new Map(), 'youtube')).toThrow(/no processor.*youtube/)
  })
})

describe('runLoop', () => {
  it('processes a queued event and stops when the signal fires', async () => {
    await insertEvent('twitch', 'follow-6', { type: 'follow' })
    const controller = new AbortController()
    const waits: number[] = []
    const wait = vi.fn(async (ms: number) => {
      waits.push(ms)
      controller.abort()
    })

    await runLoop(pool, twitchProcessor(), {
      intervalMs: 250,
      signal: controller.signal,
      wait,
    })

    expect(await markerCount()).toBe(1)
    // The first tick processed; the second found an empty queue and waited.
    expect(waits).toEqual([250])
  })

  it('waits the interval on an empty queue instead of spinning', async () => {
    const controller = new AbortController()
    const waits: number[] = []
    const wait = vi.fn(async (ms: number) => {
      waits.push(ms)
      if (waits.length === 3) controller.abort()
    })

    await runLoop(pool, new Map(), { intervalMs: 250, signal: controller.signal, wait })

    expect(waits).toEqual([250, 250, 250])
  })

  it('stops during the idle wait when the signal fires, without waiting out the interval', async () => {
    const controller = new AbortController()
    // The real timer path: the loop is asleep in the default wait when SIGTERM lands, and
    // the listener, not a full interval, is what ends it.
    const timer = setTimeout(() => controller.abort(), 40)
    try {
      await runLoop(pool, new Map(), { intervalMs: 10, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    expect(controller.signal.aborted).toBe(true)
  })

  it('does not claim anything once the signal has already fired', async () => {
    const controller = new AbortController()
    controller.abort()
    const poolWithoutDatabase = {
      connect: vi.fn(),
      query: vi.fn(),
    } as unknown as Pool

    await runLoop(poolWithoutDatabase, new Map(), { signal: controller.signal })

    expect(poolWithoutDatabase.connect).not.toHaveBeenCalled()
    expect(poolWithoutDatabase.query).not.toHaveBeenCalled()
  })

  it('logs a failed poll, waits, and still exits on an abort during that failure', async () => {
    const controller = new AbortController()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // The pool aborts the loop before the failure is reported, exercising the path where
    // the default wait sees an already-aborted signal and must not sleep for the interval.
    const brokenPool = {
      connect: async () => {
        controller.abort()
        throw new Error('the database is gone')
      },
    } as unknown as Pool

    try {
      await runLoop(brokenPool, new Map(), {
        intervalMs: 30_000,
        signal: controller.signal,
      })
      expect(errorLog).toHaveBeenCalledTimes(1)
      expect(String(errorLog.mock.calls[0]?.[0])).toContain('poll failed')
    } finally {
      errorLog.mockRestore()
    }
  })

  it('reports a provider with no processor once, leaving its events unclaimed', async () => {
    const unrouted = await insertEvent('youtube', 'subscribe-2', {})
    const controller = new AbortController()
    const waits: number[] = []
    const wait = vi.fn(async () => {
      waits.push(1)
      if (waits.length === 2) controller.abort()
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await runLoop(pool, twitchProcessor(), {
        intervalMs: 1,
        signal: controller.signal,
        wait,
      })

      // Two empty ticks, one warning: an idle queue must not repeat the same line forever.
      expect(warn).toHaveBeenCalledTimes(1)
      const message = String(warn.mock.calls[0]?.[0])
      expect(message).toContain('youtube')
      expect(message).toContain(`#${unrouted}`)

      const row = await storedEvent(unrouted)
      expect(row.processed_at).toBeNull()
      expect(row.attempts).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })
})
