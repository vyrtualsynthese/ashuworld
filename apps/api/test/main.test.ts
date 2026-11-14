import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { GameConfig } from '@ashuworld/gameconfig'
import { loadEnv, type Env } from '../src/config.js'
import { loadGameConfigFromFile, start } from '../src/main.js'

const cfg: GameConfig = {
  version: 'test',
  actions: {
    'twitch.follow': { amount: 50, provider: 'twitch' },
  },
  levels: [
    { level: 0, minXp: 0 },
    { level: 1, minXp: 100 },
  ],
}

const env = loadEnv({
  DATABASE_URL: 'postgres://ashu:ashu@localhost:5432/ashu',
  PUBLIC_BASE_URL: 'https://ashu.example',
})

/** A pool that records `end` and never opens a connection. */
function fakePool(): { pool: Pool; end: ReturnType<typeof vi.fn> } {
  const end = vi.fn(async () => undefined)
  return { pool: { end } as unknown as Pool, end }
}

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ashuworld-api-'))
  tempDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('start', () => {
  it('calls listen once and returns the app', async () => {
    const { pool } = fakePool()
    const listen = vi.fn<(app: FastifyInstance, environment: Env) => Promise<unknown>>(
      async () => undefined,
    )

    const running = await start({ env, pool, cfg, listen })

    expect(listen).toHaveBeenCalledTimes(1)
    // Compared by identity: deep equality would walk the Fastify instance's getters,
    // and `listeningOrigin` assumes a socket that this fake listen never opened.
    const call = listen.mock.calls[0]
    expect(call?.[0]).toBe(running.app)
    expect(call?.[1]).toBe(env)
    await running.stop()
  })

  it('ends the pool and sets a failing exit code when listen refuses', async () => {
    const { pool, end } = fakePool()
    const previousExitCode = process.exitCode

    try {
      await expect(
        start({
          env,
          pool,
          cfg,
          listen: async () => {
            throw new Error('address already in use')
          },
        }),
      ).rejects.toThrow('address already in use')

      expect(end).toHaveBeenCalledTimes(1)
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = previousExitCode
    }
  })

  it('still reports the listen failure when closing the pool also fails', async () => {
    const { pool, end } = fakePool()
    const previousExitCode = process.exitCode
    end.mockRejectedValueOnce(new Error('the pool is already gone'))

    try {
      await expect(
        start({
          env,
          pool,
          cfg,
          listen: async () => {
            throw new Error('address already in use')
          },
        }),
      ).rejects.toThrow('address already in use')
      expect(end).toHaveBeenCalledTimes(1)
    } finally {
      process.exitCode = previousExitCode
    }
  })
})

describe('stop', () => {
  it('closes the app, then the pool, exactly once', async () => {
    const { pool, end } = fakePool()
    const running = await start({ env, pool, cfg, listen: async () => undefined })

    const order: string[] = []
    // Assigned directly rather than spied: Fastify's `close` is overloaded with a
    // callback form whose return type no async mock can satisfy. These tests never call
    // the callback form.
    const close = vi.fn(async () => {
      order.push('app')
    })
    running.app.close = close as unknown as FastifyInstance['close']
    end.mockImplementation(async () => {
      order.push('pool')
    })

    await running.stop()
    expect(order).toEqual(['app', 'pool'])
    expect(close).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)

    await running.stop()
    expect(close).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('still ends the pool when closing the app fails', async () => {
    const { pool, end } = fakePool()
    const running = await start({ env, pool, cfg, listen: async () => undefined })
    running.app.log.level = 'silent'
    vi.spyOn(running.app, 'close').mockRejectedValueOnce(new Error('close failed'))

    await expect(running.stop()).resolves.toBeUndefined()
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('survives a failing pool.end', async () => {
    const { pool, end } = fakePool()
    const running = await start({ env, pool, cfg, listen: async () => undefined })
    running.app.log.level = 'silent'
    end.mockRejectedValueOnce(new Error('the pool is already gone'))

    await expect(running.stop()).resolves.toBeUndefined()
  })
})

describe('loadGameConfigFromFile', () => {
  it('reads a valid file', () => {
    const path = join(tempDir(), 'game.json')
    writeFileSync(
      path,
      JSON.stringify({
        version: '2026-11-14.1',
        actions: { 'twitch.follow': { amount: 50, provider: 'twitch' } },
        levels: [
          { level: 0, minXp: 0 },
          { level: 1, minXp: 100 },
        ],
      }),
    )

    expect(loadGameConfigFromFile(path).version).toBe('2026-11-14.1')
  })

  it('names the file when it is missing', () => {
    const path = join(tempDir(), 'missing-game.json')
    expect(() => loadGameConfigFromFile(path)).toThrow(path)
  })

  it('names the file when it is not valid JSON', () => {
    const path = join(tempDir(), 'game.json')
    writeFileSync(path, '{"version": ')

    expect(() => loadGameConfigFromFile(path)).toThrow(/game\.json/)
    expect(() => loadGameConfigFromFile(path)).toThrow(/not valid JSON/)
  })

  it('names the file when the config inside is invalid', () => {
    const path = join(tempDir(), 'game.json')
    writeFileSync(path, JSON.stringify({ version: 'x', actions: {}, levels: [] }))

    expect(() => loadGameConfigFromFile(path)).toThrow(path)
    expect(() => loadGameConfigFromFile(path)).toThrow(/invalid/)
  })
})
