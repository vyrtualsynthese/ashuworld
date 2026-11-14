const NUMBER = new Intl.NumberFormat('en-US')

/**
 * XP and balances are whole numbers and can get large. `1,240` is easier to read than
 * `1240`, and the format is fixed to one locale so a snapshot or a test does not change
 * with the machine it runs on.
 */
export function formatNumber(value: number): string {
  return NUMBER.format(value)
}
