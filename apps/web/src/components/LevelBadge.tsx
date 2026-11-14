/**
 * A Dachi's level, as the same badge everywhere it appears.
 *
 * The text is "Niveau 2", not just "2": a bare number next to an XP total reads as another
 * figure, and a badge that has to be explained by its neighbours is not accessible.
 * `aria-label` is left off on purpose so screen readers read the visible text.
 */
export function LevelBadge({ level }: { level: number }) {
  return <span className="level-badge">Niveau {level}</span>
}
