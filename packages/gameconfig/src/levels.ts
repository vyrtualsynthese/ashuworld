import { ConfigError, isRecord, label } from './validate.js'
import type { GameConfig } from './index.js'

export interface LevelRow {
  readonly level: number
  readonly minXp: number
}

export interface LevelPosition {
  readonly level: number
  readonly nextLevelAt: number | null
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${field} must be a non-negative integer, got ${label(value)}`)
  }
  return value
}

/**
 * Validates the level table and returns it as written.
 *
 * Row 0 is level 0 at 0 xp, then every row must have a higher level number and
 * a higher xp threshold than the row before it.
 */
export function parseLevels(raw: unknown): LevelRow[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError('levels must be a non-empty array')
  }
  const rows: LevelRow[] = []
  for (const [index, rawRow] of raw.entries()) {
    if (!isRecord(rawRow)) {
      throw new ConfigError(`levels[${index}] must be an object`)
    }
    const level = nonNegativeInteger(rawRow['level'], `levels[${index}].level`)
    const minXp = nonNegativeInteger(rawRow['minXp'], `levels[${index}].minXp`)
    const previous = rows[index - 1]
    if (previous === undefined) {
      if (level !== 0) {
        throw new ConfigError(`levels[0].level must be 0, got ${level}`)
      }
      if (minXp !== 0) {
        throw new ConfigError('levels[0].minXp must be 0')
      }
    } else {
      if (level <= previous.level) {
        throw new ConfigError(`levels[${index}].level must be greater than levels[${index - 1}].level`)
      }
      if (minXp <= previous.minXp) {
        throw new ConfigError(`levels[${index}].minXp must be greater than levels[${index - 1}].minXp`)
      }
    }
    rows.push({ level, minXp })
  }
  return rows
}

/**
 * The highest level whose threshold has been reached, plus the threshold of the
 * next level, or `null` when the fan is at the top of the table.
 */
export function levelForXp(cfg: GameConfig, xp: number): LevelPosition {
  if (!Number.isFinite(xp) || xp < 0) {
    throw new ConfigError(`xp must be a non-negative finite number, got ${label(xp)}`)
  }
  let reached: LevelRow | undefined
  for (const row of cfg.levels) {
    if (row.minXp <= xp) {
      reached = row
    }
  }
  if (reached === undefined) {
    throw new ConfigError(`no level row covers xp ${xp}`)
  }
  const next = cfg.levels.find((row) => row.minXp > xp)
  return { level: reached.level, nextLevelAt: next?.minXp ?? null }
}
