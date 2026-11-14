import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadGameConfig } from '@ashuworld/gameconfig'
import { createPool } from '@ashuworld/ledger'
import { loadEnv } from './config.js'
import { buildServer } from './server.js'

/**
 * The process entry point. Everything fallible happens here, once, before a socket is
 * opened: a missing variable or an invalid `game.json` stops the process with a message
 * that names what is wrong. `buildServer` stays synchronous and socket-free.
 *
 * The config path is relative to this file. Both `src/index.ts` (development) and
 * `dist/index.js` (built) sit three levels below the repository root, so one URL works
 * for both.
 */
const configPath = fileURLToPath(
  new URL('../../../packages/gameconfig/config/game.json', import.meta.url),
)

const env = loadEnv()
const cfg = loadGameConfig(JSON.parse(readFileSync(configPath, 'utf8')) as unknown)
const pool = createPool(env.DATABASE_URL)
const app = buildServer({ pool, cfg, env })

let shuttingDown = false

/** Stops accepting requests, then closes the pool. A second signal is ignored. */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, 'shutting down the api')
  try {
    await app.close()
    await pool.end()
  } catch (error) {
    app.log.error({ err: error }, 'shutdown did not complete cleanly')
    process.exitCode = 1
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT')
})
process.once('SIGTERM', () => {
  void shutdown('SIGTERM')
})

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' })
} catch (error) {
  app.log.error({ err: error }, 'the api could not start')
  await pool.end().catch(() => undefined)
  process.exitCode = 1
}
