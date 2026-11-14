import { ConfigError, isRecord, label } from './validate.js'
import type { GameConfig } from './index.js'

export interface LevelRow {
  readonly level: number
  readonly minXp: number
}

/**
 * How the level curve continues after the last explicit row.
 *
 * `step` is the gap from the last row to the next level; each further level multiplies
 * that gap by `factor`. The explicit table is therefore a prefix of an endless curve, not
 * a ceiling.
 */
export interface BeyondConfig {
  readonly step: number
  readonly factor: number
}

export interface LevelPosition {
  readonly level: number
  /** The threshold of the next level. There is always one: the curve never ends. */
  readonly nextLevelAt: number
}

/**
 * A hard stop for the generated part of the curve.
 *
 * XP is a 32-bit integer, so the shipped doubling curve needs about 31 steps. The cap is
 * far above that but finite: a config with a factor barely above 1 must throw a config
 * error instead of spinning forever.
 */
const MAX_GENERATED_STEPS = 100_000

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
 * Validates the rule that continues the table past its last explicit row.
 *
 * `step` must buy at least one xp of progress, and `factor` must be above 1: a factor of
 * 1 would make every further level cost exactly the same, which is a flat line, not a
 * curve.
 */
export function parseBeyond(raw: unknown): BeyondConfig {
  if (!isRecord(raw)) {
    throw new ConfigError(`beyond must be an object, got ${label(raw)}`)
  }
  const step = raw['step']
  if (typeof step !== 'number' || !Number.isInteger(step) || step <= 0) {
    throw new ConfigError(`beyond.step must be a positive integer, got ${label(step)}`)
  }
  const factor = raw['factor']
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 1) {
    throw new ConfigError(
      `beyond.factor must be a number greater than 1, got ${label(factor)}; ` +
        'a factor of 1 would make every level equally expensive',
    )
  }
  return { step, factor }
}

interface CurvePoint {
  readonly level: number
  readonly minXp: number
  /** The xp needed to go from this level to the next. */
  readonly gap: number
}

/** The last explicit row, with the first generated gap attached to it. */
function curveStart(cfg: GameConfig): CurvePoint {
  const last = cfg.levels[cfg.levels.length - 1]
  if (last === undefined) {
    throw new ConfigError('levels must be a non-empty array')
  }
  return { level: last.level, minXp: last.minXp, gap: cfg.beyond.step }
}

/**
 * The next generated level. Refuses a curve that no longer grows, so an overflowing
 * `factor` turns into a config error rather than an infinite or negative threshold.
 */
function nextCurvePoint(point: CurvePoint, factor: number): CurvePoint {
  const minXp = point.minXp + point.gap
  if (!Number.isFinite(minXp) || minXp <= point.minXp) {
    throw new ConfigError(`level curve stops growing after level ${point.level} at xp ${point.minXp}`)
  }
  return { level: point.level + 1, minXp, gap: point.gap * factor }
}

/**
 * The highest level whose threshold has been reached, plus the threshold of the next
 * level.
 *
 * Inside the explicit table this is the next written row. Past the last row the curve
 * continues with `beyond`: the first generated gap is `step`, then each gap is multiplied
 * by `factor`. `nextLevelAt` is never null, because there is always a next level.
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
  if (next !== undefined) {
    return { level: reached.level, nextLevelAt: next.minXp }
  }

  let point = curveStart(cfg)
  for (let steps = 0; steps < MAX_GENERATED_STEPS; steps += 1) {
    point = nextCurvePoint(point, cfg.beyond.factor)
    if (point.minXp > xp) {
      return { level: point.level - 1, nextLevelAt: point.minXp }
    }
  }
  throw new ConfigError(
    `level curve did not reach xp ${xp} within ${MAX_GENERATED_STEPS} levels; ` +
      'beyond.factor is too close to 1',
  )
}

/**
 * The explicit rows plus generated rows up to `upToLevel` inclusive.
 *
 * A display that shows the level ladder uses this: the config stops at its last written
 * row, but the curve does not, and a page that ended there would imply a maximum level.
 */
export function expandLevels(cfg: GameConfig, upToLevel: number): LevelRow[] {
  if (!Number.isInteger(upToLevel) || upToLevel < 0) {
    throw new ConfigError(`upToLevel must be a non-negative integer, got ${label(upToLevel)}`)
  }
  const rows = cfg.levels
    .filter((row) => row.level <= upToLevel)
    .map((row) => ({ level: row.level, minXp: row.minXp }))
  const last = cfg.levels[cfg.levels.length - 1]
  if (last === undefined) {
    throw new ConfigError('levels must be a non-empty array')
  }
  if (upToLevel <= last.level) return rows

  const toGenerate = upToLevel - last.level
  if (toGenerate > MAX_GENERATED_STEPS) {
    throw new ConfigError(
      `cannot expand levels to ${upToLevel}: more than ${MAX_GENERATED_STEPS} generated rows`,
    )
  }
  let point = curveStart(cfg)
  for (let steps = 0; steps < toGenerate; steps += 1) {
    point = nextCurvePoint(point, cfg.beyond.factor)
    rows.push({ level: point.level, minXp: point.minXp })
  }
  return rows
}
