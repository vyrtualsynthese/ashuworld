import { readFileSync } from 'node:fs'
import { loadGameConfig, type GameConfig } from './index.js'

/**
 * A `config/game.json` that could not be turned into a `GameConfig`.
 *
 * The three subclasses name the stage that failed, so a caller can tell a missing file
 * from a typo in the JSON from numbers the game cannot use. Every message carries the
 * path: the file is deployment input, and an operator reading a log needs the path more
 * than the stack.
 */
export class GameConfigFileError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

/** The file is missing, is a directory, or cannot be read for any other reason. */
export class GameConfigUnreadableError extends GameConfigFileError {
  constructor(path: string, detail: string) {
    super('GameConfigUnreadableError', `cannot read the game config at ${path}: ${detail}`)
  }
}

/** The bytes are not JSON at all, e.g. a truncated file or an editor's backup. */
export class GameConfigMalformedError extends GameConfigFileError {
  constructor(path: string, detail: string) {
    super('GameConfigMalformedError', `the game config at ${path} is not valid JSON: ${detail}`)
  }
}

/** The JSON parses but `loadGameConfig` refuses the numbers inside it. */
export class GameConfigInvalidError extends GameConfigFileError {
  constructor(path: string, detail: string) {
    super('GameConfigInvalidError', `the game config at ${path} is invalid: ${detail}`)
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Reads and validates `config/game.json`, naming the file in every failure.
 *
 * This is the one file-side counterpart to the pure `loadGameConfig`: the api and the
 * worker both need it, and a second copy is how the two would drift into disagreeing
 * about what a broken config means. The parser itself stays pure — this function owns
 * only the read, the parse and the translation of each failure into a named error.
 */
export function loadGameConfigFile(path: string): GameConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new GameConfigUnreadableError(path, reason(error))
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    throw new GameConfigMalformedError(path, reason(error))
  }

  try {
    return loadGameConfig(parsed)
  } catch (error) {
    throw new GameConfigInvalidError(path, reason(error))
  }
}
