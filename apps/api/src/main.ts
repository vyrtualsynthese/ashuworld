import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { GameConfig } from '@ashuworld/gameconfig'
import type { Env } from './config.js'
import { buildServer } from './server.js'

export const DEFAULT_LISTEN_HOST = '0.0.0.0'

export interface StartOptions {
  env: Env
  pool: Pool
  cfg: GameConfig
  /** Replaces the real `app.listen` in tests, so no socket is ever opened there. */
  listen?: (app: FastifyInstance, env: Env) => Promise<unknown>
}

export interface RunningApi {
  app: FastifyInstance
  /** Closes the app and then the pool. Calling it again does nothing. */
  stop(): Promise<void>
}

/**
 * Starts the HTTP service and returns a handle that stops it cleanly.
 *
 * The two closing steps are attempted independently: a failing `app.close()` must not
 * skip `pool.end()`, or the process would have nothing left to release and would hang
 * until it is killed. `stop` is idempotent because both signals the entry point installs
 * land on the same function, and the second one must not repeat the work.
 *
 * A listen failure ends the pool here and marks the process as failed. The caller cannot
 * use the returned value (there is none), so leaving the pool open would be a leak in the
 * one path that is already going wrong.
 */
export async function start(options: StartOptions): Promise<RunningApi> {
  const { env, pool, cfg } = options
  const app = buildServer({ pool, cfg, env })
  const listen =
    options.listen ??
    ((instance: FastifyInstance, config: Env) =>
      instance.listen({ port: config.PORT, host: DEFAULT_LISTEN_HOST }))

  try {
    await listen(app, env)
  } catch (error) {
    app.log.error({ err: error }, 'the api could not start')
    process.exitCode = 1
    try {
      await pool.end()
    } catch (endError) {
      app.log.error({ err: endError }, 'the pool did not close after a failed start')
    }
    throw error
  }

  let stopped = false

  async function stop(): Promise<void> {
    if (stopped) return
    stopped = true

    try {
      await app.close()
    } catch (error) {
      app.log.error({ err: error }, 'the api did not close cleanly')
    } finally {
      try {
        await pool.end()
      } catch (error) {
        app.log.error({ err: error }, 'the pool did not close cleanly')
      }
    }
  }

  return { app, stop }
}
