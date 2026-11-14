import { HandleTakenError, createFan, type Queryable } from '@ashuworld/ledger'

/**
 * Turning a provider's display handle into a unique fan handle.
 *
 * `fans.handle` accepts only `^[a-z0-9_]{3,24}$`, so the rules are: lowercase, collapse
 * every run of anything else into `_`, trim the edges, then pad or truncate into range.
 * The brief's collision suffixes were `-2` and `-3`; a hyphen is outside the schema's
 * character class and would be refused by Postgres, so the suffix is `_2`, `_3`. That is
 * the only difference, and it keeps a signup from failing on its fourth collision.
 *
 * De-duplication is a retry loop over `createFan`, not a pre-flight `select`: two fans can
 * ask for the same handle at once, and only the unique index decides. Each attempt runs
 * inside its own savepoint because a unique violation aborts the surrounding transaction;
 * without the rollback the retry would fail with "current transaction is aborted".
 */

export const MIN_HANDLE_LENGTH = 3
export const MAX_HANDLE_LENGTH = 24
export const FALLBACK_HANDLE = 'fan'

/**
 * How many suffixes to try before giving up. A hundred collisions on one handle means
 * something is wrong with the caller, not that the next attempt will succeed; stopping is
 * better than an unbounded loop against the database.
 */
export const MAX_HANDLE_ATTEMPTS = 100

/**
 * The first candidate: lowercased, reduced to the allowed alphabet, trimmed, and cut to
 * the schema's maximum length. Too-short results fall back to `fan`, which is itself a
 * valid handle and is then de-duplicated like any other.
 */
export function baseHandle(displayHandle: string): string {
  const normalised = displayHandle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_HANDLE_LENGTH)

  return normalised.length >= MIN_HANDLE_LENGTH ? normalised : FALLBACK_HANDLE
}

/**
 * The candidate for one attempt: the base itself, then `_2`, `_3`, ...
 *
 * The base is shortened when a suffix would push the result past the maximum, so every
 * candidate the schema sees is already valid and a long display name still deduplicates
 * instead of being refused as too long.
 */
export function suffixedHandle(base: string, attempt: number): string {
  if (attempt === 0) return base
  const suffix = `_${attempt + 1}`
  return `${base.slice(0, MAX_HANDLE_LENGTH - suffix.length)}${suffix}`
}

export interface CreateFanWithHandleInput {
  displayHandle: string
  displayName: string
}

/**
 * Creates a fan whose handle is derived from the provider's display handle.
 *
 * Must run inside a transaction (`withTransaction`): the savepoints only exist for the
 * length of one. Returns the handle it settled on so the caller can log or answer with
 * the name the fan actually got.
 */
export async function createFanWithUniqueHandle(
  tx: Queryable,
  input: CreateFanWithHandleInput,
): Promise<{ id: string; handle: string }> {
  const base = baseHandle(input.displayHandle)

  for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt += 1) {
    const handle = suffixedHandle(base, attempt)
    await tx.query('savepoint handle_attempt')
    try {
      const { id } = await createFan(tx, { handle, displayName: input.displayName })
      await tx.query('release savepoint handle_attempt')
      return { id, handle }
    } catch (error) {
      if (!(error instanceof HandleTakenError)) throw error
      // The insert aborted the transaction. Undo just that statement so the next attempt
      // can run; releasing the savepoint keeps the caller's transaction shallow.
      await tx.query('rollback to savepoint handle_attempt')
      await tx.query('release savepoint handle_attempt')
    }
  }

  throw new Error(
    `createFanWithUniqueHandle: no free handle based on "${input.displayHandle}" after ${MAX_HANDLE_ATTEMPTS} attempts`,
  )
}
