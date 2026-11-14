/**
 * A game config that cannot be used as written.
 *
 * Every validation failure names the field and the value it found, so a bad
 * `config/game.json` can be fixed without opening the parser.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** True for a plain JSON object: not null, not an array, not a primitive. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Renders a rejected value for an error message, quoting strings. */
export function label(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}
