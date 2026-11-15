import type { Pool } from 'pg'
import { withTransaction } from './db.js'

/** The environment variable the operator sets to arm the wipe. */
export const ALPHA_RESET_CONFIRM_ENV = 'ALPHA_RESET_CONFIRM'

/** The one value the confirmation variable must hold. A typo is a refusal, not a wipe. */
export const ALPHA_RESET_CONFIRM_VALUE = 'reset-ashuworld'

export type AlphaResetErrorCode = 'confirmation-required'

/**
 * A refusal to run the alpha wipe, with the reason in the message.
 *
 * Typed so the caller can tell "the operator did not arm the reset" apart from a database
 * failure and exit with a useful line instead of a stack trace. The message never leaves
 * the operator guessing: it names the variable, what it expected, and that nothing was
 * deleted.
 */
export class AlphaResetError extends Error {
  readonly code: AlphaResetErrorCode

  constructor(code: AlphaResetErrorCode, message: string) {
    super(message)
    this.name = 'AlphaResetError'
    this.code = code
  }
}

export interface ResetAlphaInput {
  /** The game config version the wipe is run against, recorded in the log line. */
  configVersion: string
}

export interface ResetAlphaResult {
  deletedEntries: number
  deletedIdentities: number
  deletedSessions: number
}

/**
 * Refuses unless `ALPHA_RESET_CONFIRM` is exactly `reset-ashuworld`.
 *
 * Separate from the transaction on purpose: a refused call must not have taken a
 * connection, and the caller should be able to reason about the guard without reading
 * SQL. Absent, blank and wrong values each get their own sentence, because "it did not
 * work" is not an actionable message in a launch-night log.
 */
function requireConfirmation(): void {
  const raw = process.env[ALPHA_RESET_CONFIRM_ENV]

  if (raw === undefined) {
    throw new AlphaResetError(
      'confirmation-required',
      `refusing the alpha wipe: ${ALPHA_RESET_CONFIRM_ENV} is not set. ` +
        `Set it to "${ALPHA_RESET_CONFIRM_VALUE}" to arm the wipe. Nothing was deleted.`,
    )
  }
  if (raw.trim() === '') {
    throw new AlphaResetError(
      'confirmation-required',
      `refusing the alpha wipe: ${ALPHA_RESET_CONFIRM_ENV} is blank. ` +
        `Set it to "${ALPHA_RESET_CONFIRM_VALUE}" to arm the wipe. Nothing was deleted.`,
    )
  }
  if (raw !== ALPHA_RESET_CONFIRM_VALUE) {
    throw new AlphaResetError(
      'confirmation-required',
      `refusing the alpha wipe: ${ALPHA_RESET_CONFIRM_ENV} does not match ` +
        `"${ALPHA_RESET_CONFIRM_VALUE}", so this looks like a typo rather than an ` +
        'operator arming the reset. Nothing was deleted.',
    )
  }
}

/**
 * Clears every XP record for the alpha launch while keeping the fan accounts.
 *
 * One transaction, so a wipe either happens completely or not at all:
 *
 * 1. count the rows about to go, for the operator's log and for the Job's output;
 * 2. truncate the ledger, the inbound queue, the handshakes, the identities, the
 *    sessions and the audit log, with `restart identity cascade` so bigserial ids start
 *    over and rows referencing a truncated table cannot block it;
 * 3. zero `fans.peak_xp` and `fans.level`, keeping handles, display names and
 *    `created_at` — the account is the fan's, the progress is the alpha's.
 *
 * `fans` and `_migrations` are deliberately not truncated. Truncating fans would cascade
 * into the very tables above and delete the accounts this operation exists to preserve;
 * `_migrations` is the schema's own history, not game data. `platform_tokens` stays too:
 * the channel owner's grant is operator configuration, loaded once through the
 * authorization command, not fan data. Wiping it would break sign-in and follow discovery
 * until an operator re-ran that command, which is not what "reset the alpha game" means.
 *
 * The confirmation is checked before `withTransaction`, so a refused call never takes a
 * connection. The log line carries the game config version the wipe ran against, because
 * the audit log is emptied by the same transaction and cannot hold it.
 */
export async function resetAlpha(
  pool: Pool,
  input: ResetAlphaInput,
): Promise<ResetAlphaResult> {
  requireConfirmation()

  const result = await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{
      entries: number
      identities: number
      sessions: number
    }>(
      `select (select count(*)::int from xp_entries) as entries,
              (select count(*)::int from provider_identities) as identities,
              (select count(*)::int from sessions) as sessions`,
    )
    const before = rows[0]
    if (before === undefined) throw new Error('the alpha reset could not count the rows to delete')

    await tx.query(
      `truncate table xp_entries, inbound_events, oauth_handshakes, provider_identities,
                      sessions, audit_log
       restart identity cascade`,
    )
    await tx.query('update fans set peak_xp = 0, level = 0')

    return {
      deletedEntries: before.entries,
      deletedIdentities: before.identities,
      deletedSessions: before.sessions,
    }
  })

  console.info(
    `[ledger] alpha reset: truncated xp_entries, inbound_events, oauth_handshakes, ` +
      `provider_identities, sessions and audit_log; fans kept with peak_xp and level zeroed; ` +
      `game config ${input.configVersion}`,
  )

  return result
}
