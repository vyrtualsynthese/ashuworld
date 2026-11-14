export {
  attachIdleErrorHandler,
  createPool,
  isUniqueViolation,
  withTransaction,
  type Queryable,
} from './db.js'
export { migrate, migrationFiles } from './migrate.js'
export {
  AwardConflictError,
  awardOnce,
  enqueueEvent,
  ingestEvent,
  type AwardConflictInput,
  type AwardInput,
  type AwardReason,
  type AwardResult,
  type EnqueueEventInput,
  type EnqueueOutcome,
  type IngestEventInput,
  type IngestOutcome,
} from './award.js'
export { ensureIdentity, type IdentityRef } from './identity.js'
export {
  InvalidMonthError,
  awardMonthly,
  monthKey,
  type MonthlyAwardInput,
  type MonthlyAwardResult,
} from './monthly.js'
export { HandleTakenError, createFan, type CreateFanInput } from './fans.js'
export { recordTermsAcceptance, touchLastSeen } from './consent.js'
export {
  detachIdentity,
  linkIdentity,
  type DetachResult,
  type IdentityChangeInput,
  type LinkResult,
} from './identities.js'
export {
  computeBalance,
  getStanding,
  recomputeLevels,
  recomputeStanding,
  type LevelRecompute,
  type Standing,
} from './standing.js'
export {
  getFanByHandle,
  listLadder,
  type FreeStandingRow,
  type Ladder,
  type LadderRow,
  type PublicFanProfile,
} from './ladder.js'
export {
  MAX_PENALTY_XP,
  PenaltyError,
  addPenalty,
  type AddPenaltyInput,
  type PenaltyErrorCode,
} from './penalty.js'
export {
  ERASURE_PEPPER_ENV,
  IdentityAttachedError,
  IdentityNotFoundError,
  eraseFan,
  eraseIdentity,
  erasedExternalId,
  exportFan,
  type EraseFanResult,
  type EraseIdentityResult,
  type ExportEntry,
  type ExportIdentity,
  type FanExport,
} from './privacy.js'
export {
  ALPHA_RESET_CONFIRM_ENV,
  ALPHA_RESET_CONFIRM_VALUE,
  AlphaResetError,
  resetAlpha,
  type AlphaResetErrorCode,
  type ResetAlphaInput,
  type ResetAlphaResult,
} from './reset.js'
