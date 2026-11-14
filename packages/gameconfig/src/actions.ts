import { isProviderName, type ProviderName } from '@ashuworld/providers'
import { ConfigError, isRecord, label } from './validate.js'
import type { GameConfig } from './index.js'

/** An action key such as `twitch.follow`, the string the ledger stores. */
export type ActionKey = string

export interface ActionDef {
  readonly amount: number
  readonly provider: ProviderName
  /**
   * The player-facing name of the action, in the site's language.
   *
   * It lives in the config rather than in the page so the words and the amount ship
   * together: a page that read one from `game.json` and the other from code could
   * describe an action the ledger does not pay.
   */
  readonly label?: string
  /** One sentence explaining the action, in the same language as `label`. */
  readonly description?: string
}

/** A required, non-empty, trimmed string field, or a ConfigError naming the action and field. */
function requiredText(key: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`action "${key}" must have a non-empty ${field}, got ${label(value)}`)
  }
  return value.trim()
}

/**
 * Validates action entries and returns them keyed by action.
 *
 * Takes an entry list rather than an object because a repeated key is only
 * expressible as a list. `JSON.parse` silently keeps the last value of a
 * duplicated key, so `loadGameConfig` hands over the entries it has and this
 * function is the one place that rejects a repeat.
 */
export function parseActions(entries: Iterable<readonly [string, unknown]>): Record<ActionKey, ActionDef> {
  // A null-prototype record keeps an action literally named `__proto__` as data
  // instead of letting the assignment change the object's prototype.
  const actions = Object.create(null) as Record<ActionKey, ActionDef>
  let count = 0
  for (const [key, value] of entries) {
    if (key.trim() === '') {
      throw new ConfigError('action keys must be non-empty')
    }
    if (Object.hasOwn(actions, key)) {
      throw new ConfigError(`action "${key}" is defined more than once`)
    }
    if (!isRecord(value)) {
      throw new ConfigError(`action "${key}" must be an object`)
    }
    const amount = value['amount']
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      throw new ConfigError(`action "${key}" must have a positive integer amount, got ${label(amount)}`)
    }
    const provider = value['provider']
    if (typeof provider !== 'string' || !isProviderName(provider)) {
      throw new ConfigError(`action "${key}" must name a known provider, got ${label(provider)}`)
    }
    const labelText = requiredText(key, 'label', value['label'])
    const descriptionText = requiredText(key, 'description', value['description'])
    actions[key] = { amount, provider, label: labelText, description: descriptionText }
    count += 1
  }
  if (count === 0) {
    throw new ConfigError('actions must contain at least one action')
  }
  return actions
}

/** The xp an action pays, or a ConfigError if the key is not in the config. */
export function actionAmount(cfg: GameConfig, key: ActionKey): number {
  const def = Object.hasOwn(cfg.actions, key) ? cfg.actions[key] : undefined
  if (def === undefined) {
    throw new ConfigError(`unknown action "${key}"`)
  }
  return def.amount
}
