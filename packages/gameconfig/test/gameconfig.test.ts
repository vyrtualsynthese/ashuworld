import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ConfigError, actionAmount, levelForXp, loadGameConfig } from '../src/index.js'
import { parseActions } from '../src/actions.js'

const followAction = {
  amount: 50,
  provider: 'twitch',
  label: 'Suivre la chaîne sur Twitch',
  description: 'Une seule fois, par compte Twitch rattaché.',
}

const valid = (): Record<string, unknown> => ({
  version: '2026-11-14.1',
  actions: {
    'twitch.follow': followAction,
    'discord.member': {
      amount: 75,
      provider: 'discord',
      label: 'Rejoindre le serveur Discord',
      description: 'Une seule fois, par compte Discord rattaché.',
    },
  },
  levels: [
    { level: 0, minXp: 0 },
    { level: 1, minXp: 100 },
    { level: 2, minXp: 300 },
  ],
})

/** The valid file with one top-level field swapped for an invalid value. */
const withField = (field: string, value: unknown): Record<string, unknown> => ({ ...valid(), [field]: value })

/** Runs `fn`, requiring it to throw ConfigError, and returns that error's message. */
function rejection(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof ConfigError) return error.message
    throw new Error(`expected ConfigError, got ${String(error)}`, { cause: error })
  }
  throw new Error('expected the call to throw ConfigError, but it returned')
}

const loadLevels = (levels: unknown): string => rejection(() => loadGameConfig(withField('levels', levels)))
const loadActions = (actions: unknown): string => rejection(() => loadGameConfig(withField('actions', actions)))

describe('game config', () => {
  it('reads action amounts', () => {
    expect(actionAmount(loadGameConfig(valid()), 'twitch.follow')).toBe(50)
  })

  it('maps xp to the highest level reached', () => {
    const cfg = loadGameConfig(valid())
    expect(levelForXp(cfg, 0)).toEqual({ level: 0, nextLevelAt: 100 })
    expect(levelForXp(cfg, 100)).toEqual({ level: 1, nextLevelAt: 300 })
    expect(levelForXp(cfg, 9999)).toEqual({ level: 2, nextLevelAt: null })
  })

  it('rejects duplicate or out-of-order level rows', () => {
    expect(() =>
      loadGameConfig({ ...valid(), levels: [ { level: 0, minXp: 0 }, { level: 1, minXp: 0 } ] }),
    ).toThrow(ConfigError)
  })

  it('rejects an unknown action key instead of paying zero', () => {
    expect(() => actionAmount(loadGameConfig(valid()), 'twitch.nope')).toThrow(ConfigError)
  })

  it('rejects a non-positive amount', () => {
    expect(() =>
      loadGameConfig({ ...valid(), actions: { 'twitch.follow': { ...followAction, amount: 0 } } }),
    ).toThrow(ConfigError)
  })
})

describe('loadGameConfig input shape', () => {
  it('rejects anything that is not an object', () => {
    for (const raw of [null, undefined, 7, 'versions', []]) {
      expect(rejection(() => loadGameConfig(raw))).toBe('config must be an object')
    }
  })

  it('rejects a missing, empty or non-string version', () => {
    for (const version of [undefined, '', '   ', 7]) {
      expect(rejection(() => loadGameConfig(withField('version', version)))).toBe(
        'version must be a non-empty string',
      )
    }
  })

  it('rejects missing, non-object and empty actions', () => {
    expect(loadActions(undefined)).toBe('actions must be an object')
    expect(loadActions(['twitch.follow'])).toBe('actions must be an object')
    expect(loadActions({})).toBe('actions must contain at least one action')
  })

  it('rejects a blank action key', () => {
    expect(loadActions({ '  ': { ...followAction } })).toBe('action keys must be non-empty')
  })

  it('rejects an action that is not an object', () => {
    expect(loadActions({ 'twitch.follow': 50 })).toBe('action "twitch.follow" must be an object')
  })

  it('rejects an action defined twice', () => {
    // JSON cannot express this: a repeated key is collapsed by the parser before it
    // reaches the config. The validator takes entries, so the guard is testable here.
    expect(
      rejection(() => parseActions([['twitch.follow', followAction], ['twitch.follow', followAction]])),
    ).toBe(
      'action "twitch.follow" is defined more than once',
    )
  })

  it('rejects an amount that is not a positive integer', () => {
    const amount = (value: unknown): string =>
      loadActions({ 'twitch.follow': { ...followAction, amount: value } })
    expect(amount(0)).toBe('action "twitch.follow" must have a positive integer amount, got 0')
    expect(amount(-5)).toBe('action "twitch.follow" must have a positive integer amount, got -5')
    expect(amount(50.5)).toBe('action "twitch.follow" must have a positive integer amount, got 50.5')
    expect(amount('50')).toBe('action "twitch.follow" must have a positive integer amount, got "50"')
    expect(amount(undefined)).toBe(
      'action "twitch.follow" must have a positive integer amount, got undefined',
    )
  })

  it('rejects a provider that is not a known platform', () => {
    const provider = (value: unknown): string =>
      loadActions({ 'twitch.follow': { ...followAction, provider: value } })
    expect(provider('myspace')).toBe('action "twitch.follow" must name a known provider, got "myspace"')
    expect(provider(42)).toBe('action "twitch.follow" must name a known provider, got 42')
  })

  it('keeps the player-facing label and description next to the amount', () => {
    const def = loadGameConfig(valid()).actions['twitch.follow']
    expect(def?.label).toBe('Suivre la chaîne sur Twitch')
    expect(def?.description).toBe('Une seule fois, par compte Twitch rattaché.')
  })

  it('rejects a missing, blank or non-string label', () => {
    const label = (value: unknown): string =>
      loadActions({ 'twitch.follow': { ...followAction, label: value } })
    expect(label(undefined)).toBe(
      'action "twitch.follow" must have a non-empty label, got undefined',
    )
    expect(label('')).toBe('action "twitch.follow" must have a non-empty label, got ""')
    expect(label('   ')).toBe('action "twitch.follow" must have a non-empty label, got "   "')
    expect(label(7)).toBe('action "twitch.follow" must have a non-empty label, got 7')
  })

  it('rejects a missing, blank or non-string description', () => {
    const description = (value: unknown): string =>
      loadActions({ 'twitch.follow': { ...followAction, description: value } })
    expect(description(undefined)).toBe(
      'action "twitch.follow" must have a non-empty description, got undefined',
    )
    expect(description('')).toBe('action "twitch.follow" must have a non-empty description, got ""')
    expect(description('  ')).toBe(
      'action "twitch.follow" must have a non-empty description, got "  "',
    )
    expect(description(null)).toBe(
      'action "twitch.follow" must have a non-empty description, got null',
    )
  })

  it('keeps a __proto__ action key as data instead of treating it as a prototype', () => {
    const raw: unknown = JSON.parse(
      '{"version":"v1","actions":{"__proto__":{"amount":1,"provider":"dev","label":"Ping","description":"Un ping local."}},"levels":[{"level":0,"minXp":0}]}',
    )
    expect(actionAmount(loadGameConfig(raw), '__proto__')).toBe(1)
  })
})

describe('level table validation', () => {
  it('rejects missing, non-array and empty levels', () => {
    expect(loadLevels(undefined)).toBe('levels must be a non-empty array')
    expect(loadLevels({ '0': { level: 0, minXp: 0 } })).toBe('levels must be a non-empty array')
    expect(loadLevels([])).toBe('levels must be a non-empty array')
  })

  it('rejects a level row that is not an object', () => {
    expect(loadLevels([{ level: 0, minXp: 0 }, 100])).toBe('levels[1] must be an object')
  })

  it('rejects a level that is not a non-negative integer', () => {
    const level = (value: unknown): string => loadLevels([{ level: 0, minXp: 0 }, { level: value, minXp: 100 }])
    expect(level(-1)).toBe('levels[1].level must be a non-negative integer, got -1')
    expect(level(1.5)).toBe('levels[1].level must be a non-negative integer, got 1.5')
    expect(level('1')).toBe('levels[1].level must be a non-negative integer, got "1"')
  })

  it('rejects a minXp that is not a non-negative integer', () => {
    const minXp = (value: unknown): string =>
      loadLevels([{ level: 0, minXp: 0 }, { level: 1, minXp: value }])
    expect(minXp(-100)).toBe('levels[1].minXp must be a non-negative integer, got -100')
    expect(minXp(100.5)).toBe('levels[1].minXp must be a non-negative integer, got 100.5')
    expect(minXp(null)).toBe('levels[1].minXp must be a non-negative integer, got null')
  })

  it('requires the table to start at level 0 with zero xp', () => {
    expect(loadLevels([{ level: 1, minXp: 0 }])).toBe('levels[0].level must be 0, got 1')
    expect(loadLevels([{ level: 0, minXp: 100 }])).toBe('levels[0].minXp must be 0')
  })

  it('requires level numbers and thresholds to increase', () => {
    expect(loadLevels([{ level: 0, minXp: 0 }, { level: 0, minXp: 100 }])).toBe(
      'levels[1].level must be greater than levels[0].level',
    )
    expect(loadLevels([{ level: 0, minXp: 0 }, { level: 1, minXp: 0 }])).toBe(
      'levels[1].minXp must be greater than levels[0].minXp',
    )
    // A gap in the level numbers is a gap in the ladder, not an ordering problem.
    expect(levelForXp(loadGameConfig({ ...valid(), levels: [{ level: 0, minXp: 0 }, { level: 2, minXp: 100 }] }), 100)).toEqual(
      { level: 2, nextLevelAt: null },
    )
  })
})

describe('levelForXp', () => {
  const cfg = loadGameConfig(valid())

  it('holds the level until the next threshold is reached', () => {
    expect(levelForXp(cfg, 99)).toEqual({ level: 0, nextLevelAt: 100 })
    expect(levelForXp(cfg, 299)).toEqual({ level: 1, nextLevelAt: 300 })
  })

  it('rejects xp that is negative or not finite', () => {
    expect(rejection(() => levelForXp(cfg, -1))).toBe('xp must be a non-negative finite number, got -1')
    expect(rejection(() => levelForXp(cfg, Number.NaN))).toBe(
      'xp must be a non-negative finite number, got NaN',
    )
  })

  it('rejects a hand-built config without level rows', () => {
    expect(rejection(() => levelForXp({ version: 'v1', actions: {}, levels: [] }, 0))).toBe(
      'no level row covers xp 0',
    )
  })
})

describe('actionAmount', () => {
  it('rejects an unknown key with the key in the message', () => {
    expect(rejection(() => actionAmount(loadGameConfig(valid()), 'twitch.nope'))).toBe(
      'unknown action "twitch.nope"',
    )
  })

  it('does not read inherited object keys as actions', () => {
    expect(rejection(() => actionAmount(loadGameConfig(valid()), 'toString'))).toBe(
      'unknown action "toString"',
    )
  })

  it('accepts the dev provider for local development', () => {
    const cfg = loadGameConfig({
      ...valid(),
      actions: {
        'dev.ping': {
          amount: 1,
          provider: 'dev',
          label: 'Ping de développement',
          description: 'Réservé au développement local.',
        },
      },
    })
    expect(actionAmount(cfg, 'dev.ping')).toBe(1)
  })
})

describe('shipped config/game.json', () => {
  const raw: unknown = JSON.parse(readFileSync(new URL('../config/game.json', import.meta.url), 'utf8'))
  const cfg = loadGameConfig(raw)

  it('carries the version the tests pin', () => {
    expect(cfg.version).toBe('2026-11-14.1')
  })

  it('pins the three alpha actions and their platforms', () => {
    expect(Object.keys(cfg.actions).sort()).toEqual(['discord.member', 'twitch.follow', 'youtube.subscribe'])
    expect(actionAmount(cfg, 'twitch.follow')).toBe(50)
    expect(actionAmount(cfg, 'youtube.subscribe')).toBe(50)
    expect(actionAmount(cfg, 'discord.member')).toBe(75)
    expect(cfg.actions['twitch.follow']?.provider).toBe('twitch')
  })

  it('carries the French label and the one-per-account rule for every action', () => {
    expect(cfg.actions['twitch.follow']).toEqual({
      amount: 50,
      provider: 'twitch',
      label: 'Suivre la chaîne sur Twitch',
      description: 'Une seule fois, par compte Twitch rattaché.',
    })
    expect(cfg.actions['youtube.subscribe']).toEqual({
      amount: 50,
      provider: 'youtube',
      label: "S'abonner à la chaîne sur YouTube",
      description: 'Une seule fois, par compte YouTube rattaché.',
    })
    expect(cfg.actions['discord.member']).toEqual({
      amount: 75,
      provider: 'discord',
      label: 'Rejoindre le serveur Discord',
      description: 'Une seule fois, par compte Discord rattaché.',
    })
  })

  it('holds the five-row level table', () => {
    expect(cfg.levels).toEqual([
      { level: 0, minXp: 0 },
      { level: 1, minXp: 100 },
      { level: 2, minXp: 300 },
      { level: 3, minXp: 700 },
      { level: 4, minXp: 1500 },
    ])
    expect(levelForXp(cfg, 1499)).toEqual({ level: 3, nextLevelAt: 1500 })
    expect(levelForXp(cfg, 1500)).toEqual({ level: 4, nextLevelAt: null })
  })
})

describe('ConfigError', () => {
  it('is a named Error so a caught failure reads as a config problem', () => {
    const error = new ConfigError('bad config')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ConfigError')
    expect(error.message).toBe('bad config')
  })
})
