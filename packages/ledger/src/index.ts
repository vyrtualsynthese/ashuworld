export {
  POOL_CONNECT_TIMEOUT_MS,
  POOL_IDLE_TIMEOUT_MS,
  POOL_MAX_CLIENTS,
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
export {
  ensureIdentity,
  findIdentityForLogin,
  refreshIdentityHandle,
  type IdentityRef,
  type LoginIdentityRef,
} from './identity.js'
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
  AUDIT_RETENTION_DAYS,
  ERASURE_PEPPER_ENV,
  INACTIVE_FAN_RETENTION_DAYS,
  FanNotFoundError,
  IdentityAttachedError,
  IdentityNotFoundError,
  NEVER_LINKED_IDENTITY_RETENTION_DAYS,
  PROCESSED_EVENT_RETENTION_DAYS,
  PURGE_CONFIRM_ENV,
  PURGE_CONFIRM_VALUE,
  eraseFan,
  eraseIdentity,
  erasedExternalId,
  exportFan,
  findActiveFanId,
  findIdentityIdsByHandle,
  purgeBatch,
  type EraseFanResult,
  type EraseIdentityResult,
  type ExportEntry,
  type ExportIdentity,
  type FanExport,
  type PurgeResult,
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
