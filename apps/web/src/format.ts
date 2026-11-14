const NUMBER = new Intl.NumberFormat('fr-FR')

/**
 * XP and balances are whole numbers and can get large. `1 240` is easier to read than
 * `1240`, and the format is fixed to one locale so a snapshot or a test does not change
 * with the machine it runs on. It is the app's locale, not the visitor's: the interface is
 * French, so a French thousands separator belongs in a French balance.
 */
export function formatNumber(value: number): string {
  return NUMBER.format(value)
}
