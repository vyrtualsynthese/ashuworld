import { isUniqueViolation, type Queryable } from './db.js'

export interface CreateFanInput {
  handle: string
  displayName: string
}

/**
 * The database already holds this handle.
 *
 * A typed error rather than a boolean, because the caller cannot repair it by retrying:
 * it has to pick a different handle and say so to the person typing. Task 10 builds the
 * de-duplication on top of this, and needs to recognise exactly this refusal — not a
 * malformed handle, which is a different conversation with the fan.
 */
export class HandleTakenError extends Error {
  readonly handle: string

  constructor(handle: string) {
    super(`handle "${handle}" is already taken`)
    this.name = 'HandleTakenError'
    this.handle = handle
  }
}

/**
 * Creates a fan account and returns its id.
 *
 * `fans_handle_key` is the only refusal this function translates. The schema's handle
 * format check and any other unique constraint keep their own errors: reporting a
 * malformed handle as "taken" would send the caller looking for a duplicate that does not
 * exist, and reporting an unknown refusal as "taken" would hide a bug.
 */
export async function createFan(tx: Queryable, input: CreateFanInput): Promise<{ id: string }> {
  try {
    const { rows } = await tx.query<{ id: string }>(
      `insert into fans (handle, display_name)
       values ($1, $2)
       returning id`,
      [input.handle, input.displayName],
    )
    const row = rows[0]
    if (row === undefined) {
      // An insert with `returning` yields a row or raises. No row means something this
      // code does not model happened; inventing an id or reporting success would be worse.
      throw new Error(`createFan: insert returned no row for handle "${input.handle}"`)
    }
    return { id: row.id }
  } catch (error) {
    if (isUniqueViolation(error, 'fans_handle_key')) throw new HandleTakenError(input.handle)
    throw error
  }
}
