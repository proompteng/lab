import { Schema } from 'effect'

/** Bounded failure identifiers, never broker payloads or free-form exception messages. */
export enum SubmissionDenialReason {
  Unclassified = 'UNCLASSIFIED_INVALID_REQUEST',
  InvalidIntent = 'INVALID_INTENT',
  RequestEncoding = 'REQUEST_ENCODING',
  FractionalTradingDisabled = 'FRACTIONAL_TRADING_DISABLED',
  AccountMismatch = 'ACCOUNT_MISMATCH',
  OrderContract = 'ORDER_CONTRACT',
  ProjectionRequired = 'BROKER_PROJECTION_REQUIRED',
  ExpiredRiskDecision = 'RISK_DECISION_EXPIRED',
  InvalidRiskDecision = 'RISK_DECISION_INVALID',
  ExecutionWindowExpired = 'SUBMISSION_WINDOW_EXPIRED',
  BrokerStateStale = 'BROKER_STATE_STALE',
  BrokerStateObservationInvalid = 'BROKER_STATE_TIME_INVALID',
  BrokerStateObservationInFuture = 'BROKER_STATE_IN_FUTURE',
  BrokerStateCacheUnavailable = 'BROKER_STATE_CACHE_UNAVAILABLE',
  BrokerStateConsumed = 'BROKER_STATE_CONSUMED',
  ReconciliationStoreError = 'BROKER_RECONCILIATION_FAILED',
  BrokerReadError = 'BROKER_OBSERVATION_UNAVAILABLE',
  BrokerAccountUnavailable = 'BROKER_ACCOUNT_UNAVAILABLE',
  BrokerPositionSnapshotChanged = 'BROKER_POSITIONS_CHANGED',
  BrokerOpenOrderSnapshotChanged = 'BROKER_ORDERS_CHANGED',
  BrokerAccountSnapshotChanged = 'BROKER_CASH_CHANGED',
  IntentAuthorityGenerationMismatch = 'AUTHORITY_GENERATION_CHANGED',
  IntentStrategyMismatch = 'STRATEGY_BINDING_CHANGED',
  MutationStoreError = 'MUTATION_AUTHORIZATION_FAILED',
  WriterFenceError = 'WRITER_FENCE_FAILED',
  InstrumentError = 'INSTRUMENT_NOT_ELIGIBLE',
  PersistedCapitalGrantMissing = 'CAPITAL_GRANT_MISSING',
  PersistedCapitalGrantHashMismatch = 'CAPITAL_GRANT_CHANGED',
  FreshAuthorityCapabilityMismatch = 'CAPITAL_AUTHORITY_CHANGED',
  ExecutionRiskPolicyInvalid = 'RISK_POLICY_INVALID',
  ExecutionRiskPolicyHashMismatch = 'RISK_POLICY_CHANGED',
  OrderNotionalLimitExceeded = 'ORDER_NOTIONAL_EXCEEDED',
  BuyingPowerExceeded = 'BUYING_POWER_EXCEEDED',
  PositionNotionalLimitExceeded = 'POSITION_NOTIONAL_EXCEEDED',
  GrossNotionalLimitExceeded = 'GROSS_NOTIONAL_EXCEEDED',
  NetExposureLimitExceeded = 'NET_EXPOSURE_EXCEEDED',
  DailyTradedNotionalLimitExceeded = 'DAILY_TURNOVER_EXCEEDED',
  DailyLossLimitExceeded = 'DAILY_LOSS_EXCEEDED',
  DrawdownLimitExceeded = 'DRAWDOWN_EXCEEDED',
  OpenOrderLimitExceeded = 'OPEN_ORDERS_EXCEEDED',
  CloseOnlyOrderNotReducing = 'CLOSE_NOT_REDUCING',
  PendingSellUncovered = 'PENDING_SELL_UNCOVERED',
  IncreasingSellUnsupported = 'INCREASING_SELL_UNSUPPORTED',
}

export const SubmissionDenialReasonSchema = Schema.Enum(SubmissionDenialReason)

export const submissionDenialReason = (cause: unknown): SubmissionDenialReason => {
  if (typeof cause !== 'object' || cause === null) return SubmissionDenialReason.Unclassified
  const tag = '_tag' in cause ? cause._tag : 'tag' in cause ? cause.tag : undefined
  if (tag === 'BrokerStateCacheUnavailable' && 'reason' in cause) {
    if (cause.reason === 'stale') return SubmissionDenialReason.BrokerStateStale
    if (cause.reason === 'consumed') return SubmissionDenialReason.BrokerStateConsumed
  }
  if (
    tag === 'IntentAccountMismatch' ||
    tag === 'BrokerAccountMismatch' ||
    tag === 'BrokerPositionAccountMismatch' ||
    tag === 'BrokerOrderAccountMismatch' ||
    tag === 'ExecutionRiskPolicyAccountMismatch'
  )
    return SubmissionDenialReason.AccountMismatch
  // Enum keys are the owning failure tags. Unknown tags stay explicitly unclassified.
  return typeof tag === 'string' && Object.hasOwn(SubmissionDenialReason, tag)
    ? SubmissionDenialReason[tag as keyof typeof SubmissionDenialReason]
    : SubmissionDenialReason.Unclassified
}
