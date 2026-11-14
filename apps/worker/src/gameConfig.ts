import { fileURLToPath } from 'node:url'
import { loadGameConfigFile, type GameConfig } from '@ashuworld/gameconfig'

/**
 * The same file the api reads, resolved from this module rather than from an environment
 * variable, so both bundles find `/packages/gameconfig/config/game.json` in the image.
 * From `apps/worker/src/gameConfig.ts` the three levels climb to the repository root; from the
 * bundled `/app/dist/worker.js` they reach `/`, which is where both Dockerfiles place it.
 */
export const GAME_CONFIG_PATH = fileURLToPath(
  new URL('../../../packages/gameconfig/config/game.json', import.meta.url),
)

/**
 * The game numbers this process runs with.
 *
 * It is the api's file, not a copy and not an environment variable: a worker that paid
 * actions from a different table than the api reads would show fans a balance the ladder
 * does not agree with.
 */
export function loadWorkerGameConfig(): GameConfig {
  return loadGameConfigFile(GAME_CONFIG_PATH)
}
