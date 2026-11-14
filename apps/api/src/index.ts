import { fileURLToPath } from 'node:url'
import { createPool } from '@ashuworld/ledger'
import { loadEnv } from './config.js'
import { loadGameConfigFromFile, start } from './main.js'

/**
 * The process shell. All the logic lives in `config.ts`, `main.ts` and `server.ts`, so
 * this file only wires the real environment, the real file and a real pool together.
 * Startup failures are printed as one line and leave a non-zero exit code instead of a
 * raw stack; `start` has already logged a listen failure.
 */
const configPath = fileURLToPath(
  new URL('../../../packages/gameconfig/config/game.json', import.meta.url),
)

async function main(): Promise<void> {
  try {
    const env = loadEnv()
    const cfg = loadGameConfigFromFile(configPath)
    const pool = createPool(env.DATABASE_URL)
    const { stop } = await start({ env, pool, cfg })

    // A second signal reaches the same idempotent stop, so it is a no-op.
    process.on('SIGINT', () => {
      void stop()
    })
    process.on('SIGTERM', () => {
      void stop()
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

await main()
