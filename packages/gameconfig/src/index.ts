import { parseActions, type ActionDef, type ActionKey } from './actions.js'
import { parseLevels, type LevelRow } from './levels.js'
import { ConfigError, isRecord } from './validate.js'

export { ConfigError } from './validate.js'
export { actionAmount, type ActionDef, type ActionKey } from './actions.js'
export { levelForXp, type LevelPosition, type LevelRow } from './levels.js'

/** One versioned snapshot of the game's numbers. */
export interface GameConfig {
  version: string
  actions: Record<ActionKey, ActionDef>
  levels: LevelRow[]
}

/**
 * Validates parsed `config/game.json` and returns it as a `GameConfig`.
 *
 * Pure by design: it receives an already-parsed value so the caller owns the
 * file read and the parser is the same in tests, the api and the worker.
 */
export function loadGameConfig(raw: unknown): GameConfig {
  if (!isRecord(raw)) {
    throw new ConfigError('config must be an object')
  }
  const version = raw['version']
  if (typeof version !== 'string' || version.trim() === '') {
    throw new ConfigError('version must be a non-empty string')
  }
  const rawActions = raw['actions']
  if (!isRecord(rawActions)) {
    throw new ConfigError('actions must be an object')
  }
  return {
    version,
    actions: parseActions(Object.entries(rawActions)),
    levels: parseLevels(raw['levels']),
  }
}
