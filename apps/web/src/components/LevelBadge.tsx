/**
 * A fan's level, as the same badge everywhere it appears.
 *
 * The text is "Level 2", not just "2": a bare number next to a balance reads as another
 * figure, and a badge that has to be explained by its neighbours is not accessible.
 * `aria-label` is left off on purpose so screen readers read the visible text.
 */
export function LevelBadge({ level }: { level: number }) {
  return <span className="level-badge">Level {level}</span>
}
