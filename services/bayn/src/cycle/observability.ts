import { DateTime, Option, Result } from 'effect'

import { Authority, KillState, ReconciliationStatus } from '../execution/contracts'
import { Pipeable } from '../pipeable'
import type { IsoDate } from '../schemas'
import { utcInstantFromEpochMillisResult, type UtcEpochMillisFailure } from '../time'
import { CycleState, CycleTerminalReason } from './model'

export interface CycleOperationsThresholds {
  readonly cycleStallThresholdMs: number
  readonly reconciliationStaleThresholdMs: number
  readonly unknownMutationThresholdMs: number
}

export enum MonthEndCadenceCondition {
  Due = 'DUE',
  ExpectedWait = 'EXPECTED_WAIT',
  NotApplicable = 'NOT_APPLICABLE',
  Stalled = 'STALLED',
  Unknown = 'UNKNOWN',
}

export enum MonthEndCadenceReason {
  CyclePassStale = 'CYCLE_PASS_STALE',
  FutureCalendarEvidenceUnavailable = 'FUTURE_CALENDAR_EVIDENCE_UNAVAILABLE',
  InvalidOrInsufficientCalendarEvidence = 'INVALID_OR_INSUFFICIENT_CALENDAR_EVIDENCE',
  LatestPassFailed = 'LATEST_PASS_FAILED',
  MonthEndCadenceNotDue = 'MONTH_END_CADENCE_NOT_DUE',
  NoPassRecorded = 'NO_PASS_RECORDED',
  PassOutcomeNotApplicable = 'PASS_OUTCOME_NOT_APPLICABLE',
  RunnerUnavailable = 'RUNNER_UNAVAILABLE',
  SignalAndExecutionSessionSameMonth = 'SIGNAL_AND_EXECUTION_SESSION_SAME_MONTH',
  SignalToExecutionMonthTransition = 'SIGNAL_TO_EXECUTION_MONTH_TRANSITION',
}

export type MonthEndCadenceNextEligibility =
  | {
      readonly status: 'PROVEN'
      readonly sessionDate: IsoDate
      readonly basis: 'EXECUTION_SESSION_MONTH_TRANSITION'
    }
  | {
      readonly status: 'UNKNOWN'
      readonly reason:
        | MonthEndCadenceReason.FutureCalendarEvidenceUnavailable
        | MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence
    }

export interface MonthEndCadenceDecision {
  readonly schemaVersion: 'bayn.month-end-cadence-decision.v1'
  readonly condition:
    | MonthEndCadenceCondition.Due
    | MonthEndCadenceCondition.ExpectedWait
    | MonthEndCadenceCondition.Unknown
  readonly reason:
    | MonthEndCadenceReason.SignalAndExecutionSessionSameMonth
    | MonthEndCadenceReason.SignalToExecutionMonthTransition
    | MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence
  readonly signalSessionDate: IsoDate | null
  readonly executionSessionDate: IsoDate | null
  readonly nextEligibility: MonthEndCadenceNextEligibility
}

export type AutonomousCycleCadenceObservation = {
  readonly schemaVersion: 'bayn.autonomous-cycle-cadence-observation.v1'
  readonly condition: MonthEndCadenceCondition
  readonly reason: MonthEndCadenceReason
  readonly signalSessionDate: IsoDate | null
  readonly executionSessionDate: IsoDate | null
  readonly nextEligibility: MonthEndCadenceNextEligibility
}

export type AutonomousCycleCadenceFreshness = 'AVAILABLE' | 'STALE' | 'UNAVAILABLE'

const isIsoDate = (value: string | undefined): value is IsoDate => {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = DateTime.make(`${value}T00:00:00.000Z`)
  return Option.isSome(date) && DateTime.formatIsoDate(date.value) === value
}

const unknownNextEligibility = (
  reason:
    | MonthEndCadenceReason.FutureCalendarEvidenceUnavailable
    | MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence,
): MonthEndCadenceNextEligibility => ({ status: 'UNKNOWN', reason })

export const decideMonthEndCadenceEligibility = (facts: {
  readonly signalSessionDate?: string
  readonly executionSessionDate?: string
}): MonthEndCadenceDecision => {
  if (
    !isIsoDate(facts.signalSessionDate) ||
    !isIsoDate(facts.executionSessionDate) ||
    facts.signalSessionDate >= facts.executionSessionDate
  ) {
    return {
      schemaVersion: 'bayn.month-end-cadence-decision.v1',
      condition: MonthEndCadenceCondition.Unknown,
      reason: MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence,
      signalSessionDate: isIsoDate(facts.signalSessionDate) ? facts.signalSessionDate : null,
      executionSessionDate: isIsoDate(facts.executionSessionDate) ? facts.executionSessionDate : null,
      nextEligibility: unknownNextEligibility(MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence),
    }
  }

  if (facts.signalSessionDate.slice(0, 7) !== facts.executionSessionDate.slice(0, 7)) {
    return {
      schemaVersion: 'bayn.month-end-cadence-decision.v1',
      condition: MonthEndCadenceCondition.Due,
      reason: MonthEndCadenceReason.SignalToExecutionMonthTransition,
      signalSessionDate: facts.signalSessionDate,
      executionSessionDate: facts.executionSessionDate,
      nextEligibility: {
        status: 'PROVEN',
        sessionDate: facts.executionSessionDate,
        basis: 'EXECUTION_SESSION_MONTH_TRANSITION',
      },
    }
  }

  return {
    schemaVersion: 'bayn.month-end-cadence-decision.v1',
    condition: MonthEndCadenceCondition.ExpectedWait,
    reason: MonthEndCadenceReason.SignalAndExecutionSessionSameMonth,
    signalSessionDate: facts.signalSessionDate,
    executionSessionDate: facts.executionSessionDate,
    nextEligibility: unknownNextEligibility(MonthEndCadenceReason.FutureCalendarEvidenceUnavailable),
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

export const retainedAutonomousCycleCadenceDecision = (observation: unknown): MonthEndCadenceDecision | undefined => {
  if (!isRecord(observation) || !Object.hasOwn(observation, 'cadenceDecision')) return undefined
  const retained = observation['cadenceDecision']
  if (!isRecord(retained)) return decideMonthEndCadenceEligibility({})
  return decideMonthEndCadenceEligibility({
    ...(typeof retained['signalSessionDate'] === 'string' ? { signalSessionDate: retained['signalSessionDate'] } : {}),
    ...(typeof retained['executionSessionDate'] === 'string'
      ? { executionSessionDate: retained['executionSessionDate'] }
      : {}),
  })
}

export const projectAutonomousCycleCadenceObservation = (input: {
  readonly configured: boolean
  readonly lastPassResult: 'SUCCESS' | 'FAILURE' | null
  readonly lastPassOutcome: string | null
  readonly freshness: AutonomousCycleCadenceFreshness
  readonly cadence?: 'MONTHLY' | 'EVERY_SESSION'
  readonly cadenceDecision?: MonthEndCadenceDecision
}): AutonomousCycleCadenceObservation => {
  const common = { schemaVersion: 'bayn.autonomous-cycle-cadence-observation.v1' } as const
  const unavailable = unknownNextEligibility(MonthEndCadenceReason.FutureCalendarEvidenceUnavailable)
  const retainedEvidence =
    input.cadence === 'EVERY_SESSION'
      ? { signalSessionDate: null, executionSessionDate: null, nextEligibility: unavailable }
      : {
          signalSessionDate: input.cadenceDecision?.signalSessionDate ?? null,
          executionSessionDate: input.cadenceDecision?.executionSessionDate ?? null,
          nextEligibility: input.cadenceDecision?.nextEligibility ?? unavailable,
        }
  if (!input.configured) {
    return {
      ...common,
      condition: MonthEndCadenceCondition.Unknown,
      reason: MonthEndCadenceReason.NoPassRecorded,
      signalSessionDate: null,
      executionSessionDate: null,
      nextEligibility: unavailable,
    }
  }
  if (input.lastPassResult === null && input.freshness === 'STALE') {
    return {
      ...common,
      condition: MonthEndCadenceCondition.Stalled,
      reason: MonthEndCadenceReason.CyclePassStale,
      signalSessionDate: null,
      executionSessionDate: null,
      nextEligibility: unavailable,
    }
  }
  if (input.lastPassResult === null && input.freshness === 'UNAVAILABLE') {
    return {
      ...common,
      condition: MonthEndCadenceCondition.Unknown,
      reason: MonthEndCadenceReason.RunnerUnavailable,
      signalSessionDate: null,
      executionSessionDate: null,
      nextEligibility: unavailable,
    }
  }
  if (input.lastPassResult === null) {
    return {
      ...common,
      condition: MonthEndCadenceCondition.Unknown,
      reason: MonthEndCadenceReason.NoPassRecorded,
      signalSessionDate: null,
      executionSessionDate: null,
      nextEligibility: unavailable,
    }
  }
  if (input.lastPassResult === 'FAILURE') {
    return {
      ...common,
      condition: MonthEndCadenceCondition.Unknown,
      reason: MonthEndCadenceReason.LatestPassFailed,
      signalSessionDate: null,
      executionSessionDate: null,
      nextEligibility: unavailable,
    }
  }
  if (input.freshness === 'STALE') {
    return {
      ...common,
      condition: MonthEndCadenceCondition.Stalled,
      reason: MonthEndCadenceReason.CyclePassStale,
      ...retainedEvidence,
    }
  }
  if (input.freshness === 'UNAVAILABLE') {
    return {
      ...common,
      condition: MonthEndCadenceCondition.Unknown,
      reason: MonthEndCadenceReason.RunnerUnavailable,
      ...retainedEvidence,
    }
  }
  if (input.cadence === 'EVERY_SESSION') {
    return {
      ...common,
      condition: MonthEndCadenceCondition.NotApplicable,
      reason: MonthEndCadenceReason.PassOutcomeNotApplicable,
      signalSessionDate: null,
      executionSessionDate: null,
      nextEligibility: unavailable,
    }
  }
  if (input.cadenceDecision !== undefined) {
    return {
      ...common,
      condition: input.cadenceDecision.condition,
      reason: input.cadenceDecision.reason,
      signalSessionDate: input.cadenceDecision.signalSessionDate,
      executionSessionDate: input.cadenceDecision.executionSessionDate,
      nextEligibility: input.cadenceDecision.nextEligibility,
    }
  }
  if (input.lastPassOutcome !== 'NOT_DUE') {
    return {
      ...common,
      condition: MonthEndCadenceCondition.NotApplicable,
      reason: MonthEndCadenceReason.PassOutcomeNotApplicable,
      signalSessionDate: null,
      executionSessionDate: null,
      nextEligibility: unavailable,
    }
  }
  return {
    ...common,
    condition: MonthEndCadenceCondition.ExpectedWait,
    reason: MonthEndCadenceReason.MonthEndCadenceNotDue,
    signalSessionDate: null,
    executionSessionDate: null,
    nextEligibility: unavailable,
  }
}

export interface CycleOperationsSnapshot {
  readonly cycleId: string
  readonly accountId: string
  readonly signalSessionDate: string
  readonly executionSessionDate: string
  readonly phase: CycleState
  readonly snapshotId: string | null
  readonly decisionHash: string | null
  readonly terminalReason: CycleTerminalReason | null
  readonly submissionOpenAt: string
  readonly submissionCutoffAt: string
  readonly executionOpenAt: string
  readonly executionCloseAt: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly terminalAt: string | null
}

export interface DurableAuthorityObservation {
  readonly generationHash: string
  readonly maximum: Authority
  readonly effective: Authority
  readonly kill: KillState
  readonly reason: string | null
  readonly updatedAt: string
}

export interface ReconciliationObservation {
  readonly accountId: string
  readonly reconciliationId: string
  readonly status: ReconciliationStatus
  readonly discrepancyCount: number
  readonly reconciledAt: string
  readonly coversLatestMutation: boolean
}

export interface MutationObservation {
  readonly eventCount: number
  readonly recoveryFoundCount: number
  readonly approvedIntentCount: number
  readonly acknowledgedIntentCount: number
  readonly unresolvedCount: number
  readonly oldestUnresolvedAt: string | null
  readonly latestOccurredAt: string | null
}

export type ObservedTargetPlanStatus = 'PLANNED' | 'NO_TRADE' | 'BLOCKED'

export interface CycleDecisionObservation {
  readonly createdAt: string
  readonly marketDataObservedAt: string | null
  readonly barCount: number
  readonly quoteCount: number
  readonly tradeCount: number
  readonly targetPlanStatus: ObservedTargetPlanStatus
  readonly targetPlanReason: string | null
  readonly targetCount: number
  readonly orderedIntentCount: number
  readonly dispatchable: boolean
  readonly riskBlockReason: string | null
  readonly riskBlockReasonCount: number
}

export interface CycleExecutionFunnelObservation {
  /** Execution facts are scoped to the current cycle, or the latest terminal cycle when idle. */
  readonly decision: CycleDecisionObservation | null
  readonly intentCount: number
  readonly plannedIntentCount: number
  readonly approvedIntentCount: number
  readonly ioStartedIntentCount: number
  readonly acknowledgedIntentCount: number
  readonly unknownIntentCount: number
  readonly terminalIntentCount: number
  readonly recoveredIntentCount: number
  readonly filledIntentCount: number
  readonly canceledIntentCount: number
  readonly expiredIntentCount: number
  readonly rejectedIntentCount: number
  readonly blockedIntentCount: number
  readonly orderCount: number
  readonly openOrderCount: number
  readonly filledOrderCount: number
  /** Distinct broker orders with at least one durable fill, independent of latest order status. */
  readonly executedOrderCount: number
  readonly canceledOrderCount: number
  readonly expiredOrderCount: number
  readonly rejectedOrderCount: number
  readonly fillCount: number
  readonly buyFillCount: number
  readonly sellFillCount: number
  readonly latestIntentAt: string | null
  readonly latestOrderAt: string | null
  readonly latestFillAt: string | null
  readonly maximumOrderAcknowledgementLatencyMs: number | null
  readonly maximumFillLatencyMs: number | null
  /** Null means no complete broker position snapshot has been observed. */
  readonly positionSnapshotObservedAt: string | null
  readonly positionCount: number | null
  readonly grossExposureMicros: string | null
  readonly netExposureMicros: string | null
  readonly unrealizedPnlMicros: string | null
  readonly accountObservedAt: string | null
  readonly cashMicros: string | null
  readonly equityMicros: string | null
  readonly buyingPowerMicros: string | null
}

export interface AccountingEconomicsObservation {
  readonly fillCount: number
  readonly transactionCount: number
  readonly receiptCount: number
  readonly realizedCloseCount: number
  readonly unaccountedFillCount: number
  readonly unreceiptedTransactionCount: number
  readonly grossRealizedPnlMicros: string
  readonly executionFeesMicros: string
  readonly netRealizedPnlAfterExecutionFeesMicros: string
}

export interface ForwardPerformanceObservation {
  readonly createdAt: string
  readonly evidenceStatus: 'SUFFICIENT' | 'INSUFFICIENT_EVIDENCE'
  readonly profitability: 'PROFITABLE' | 'NOT_PROFITABLE' | 'UNDETERMINED'
  readonly grossRealizedPnlMicros: string | null
  readonly brokerExecutionFeesMicros: string | null
  readonly otherChargedCostsMicros: string | null
  readonly netRealizedPnlAfterCostsMicros: string | null
  readonly netRealizedReturnDecimal: string | null
  readonly completedExecutionCount: number
  readonly realizedCloseCount: number
  readonly accountingReceiptsExact: boolean
  readonly ledgerExact: boolean
}

export interface CycleEconomicsObservation {
  readonly accounting: AccountingEconomicsObservation
  readonly forwardPerformance: ForwardPerformanceObservation | null
}

export interface CycleOperationsProjection {
  readonly current: CycleOperationsSnapshot | null
  readonly last: CycleOperationsSnapshot | null
  readonly unfinishedCycleCount: number
  readonly authority: DurableAuthorityObservation | null
  readonly reconciliation: ReconciliationObservation | null
  readonly mutations: MutationObservation
  readonly execution?: CycleExecutionFunnelObservation
  readonly economics?: CycleEconomicsObservation
}

export enum CycleOperationsCondition {
  Unknown = 'UNKNOWN',
  Waiting = 'WAITING',
  Running = 'RUNNING',
  Stalled = 'STALLED',
  Failed = 'FAILED',
}

export enum CycleOperationsReason {
  ObservationUnavailable = 'OBSERVATION_UNAVAILABLE',
  NoCycleRecorded = 'NO_CYCLE_RECORDED',
  AwaitingSignalPublication = 'AWAITING_SIGNAL_PUBLICATION',
  AwaitingSubmissionOpen = 'AWAITING_SUBMISSION_OPEN',
  AwaitingActivation = 'AWAITING_ACTIVATION',
  AwaitingDecision = 'AWAITING_DECISION',
  Active = 'ACTIVE',
  LastCycleCompleted = 'LAST_CYCLE_COMPLETED',
  LastCycleNoTrade = 'LAST_CYCLE_NO_TRADE',
  LastCycleBlocked = 'LAST_CYCLE_BLOCKED',
  MissedPublicationDeadline = 'MISSED_PUBLICATION_DEADLINE',
  MissedSubmissionCutoff = 'MISSED_SUBMISSION_CUTOFF',
  MissedExecutionClose = 'MISSED_EXECUTION_CLOSE',
  AttemptStale = 'ATTEMPT_STALE',
  MultipleUnfinishedCycles = 'MULTIPLE_UNFINISHED_CYCLES',
  AuthorityMissing = 'AUTHORITY_MISSING',
  AuthorityMaximumMismatch = 'AUTHORITY_MAXIMUM_MISMATCH',
  KillActive = 'KILL_ACTIVE',
  UnresolvedMutation = 'UNRESOLVED_MUTATION',
  ReconciliationMissing = 'RECONCILIATION_MISSING',
  ReconciliationDiscrepancy = 'RECONCILIATION_DISCREPANCY',
  ReconciliationPredatesMutation = 'RECONCILIATION_PREDATES_MUTATION',
  ReconciliationStale = 'RECONCILIATION_STALE',
  StaleExecutionBootstrapSkipped = 'STALE_CAPITAL_BOOTSTRAP_SKIPPED',
  ResearchCapitalBootstrapRecovered = 'RESEARCH_CAPITAL_BOOTSTRAP_RECOVERED',
}

export interface CycleOperationsAlerts {
  readonly cycleStalled: boolean
  readonly cycleFailed: boolean
  readonly unknownMutationStale: boolean
  readonly reconciliationBlocked: boolean
  readonly killActive: boolean
  readonly authorityIncoherent: boolean
}

export interface CycleOperationsStatus extends CycleOperationsProjection {
  readonly schemaVersion: 'bayn.cycle-operations-status.v1'
  readonly condition: CycleOperationsCondition
  readonly reason: CycleOperationsReason
  readonly checkedAt: string | null
  readonly attemptAgeMs: number | null
  readonly oldestUnresolvedMutationAgeMs: number | null
  readonly reconciliationAgeMs: number | null
  readonly reconciliationCoversLatestMutation: boolean | null
  readonly zeroMutation: boolean | null
  readonly alerts: CycleOperationsAlerts
  readonly error: string | null
}

export type CycleOperationsStatusFailure = {
  readonly _tag: 'CycleOperationsClockInvalid'
  readonly nowMs: number
  readonly cause: UtcEpochMillisFailure
}

export const renderCycleOperationsStatusFailure = (failure: CycleOperationsStatusFailure): string => {
  switch (failure.cause._tag) {
    case 'UtcEpochMillisNotSafeInteger':
      return `cycle operations clock must be a safe integer epoch millisecond: observed=${failure.nowMs}`
    case 'UtcEpochMillisOutOfRange':
      return `cycle operations clock is outside the supported UTC range: observed=${failure.nowMs}`
  }
}

const ageAt = (instant: string | null, nowMs: number): number | null =>
  instant === null ? null : Math.max(0, nowMs - Date.parse(instant))

const initialProjection = (): CycleOperationsProjection => ({
  current: null,
  last: null,
  unfinishedCycleCount: 0,
  authority: null,
  reconciliation: null,
  mutations: {
    eventCount: 0,
    recoveryFoundCount: 0,
    approvedIntentCount: 0,
    acknowledgedIntentCount: 0,
    unresolvedCount: 0,
    oldestUnresolvedAt: null,
    latestOccurredAt: null,
  },
})

export const unknownCycleOperationsStatus = (error: string | null = null): CycleOperationsStatus => ({
  schemaVersion: 'bayn.cycle-operations-status.v1',
  ...initialProjection(),
  condition: CycleOperationsCondition.Unknown,
  reason: CycleOperationsReason.ObservationUnavailable,
  checkedAt: null,
  attemptAgeMs: null,
  oldestUnresolvedMutationAgeMs: null,
  reconciliationAgeMs: null,
  reconciliationCoversLatestMutation: null,
  zeroMutation: null,
  alerts: {
    cycleStalled: false,
    cycleFailed: false,
    unknownMutationStale: false,
    reconciliationBlocked: false,
    killActive: false,
    authorityIncoherent: false,
  },
  error,
})

const lifecycleCondition = (
  projection: CycleOperationsProjection,
  nowMs: number,
  cycleStallThresholdMs: number,
  maximumAuthority: Authority,
): readonly [CycleOperationsCondition, CycleOperationsReason] => {
  const current = projection.current
  if (current === null) {
    if (projection.last?.phase === CycleState.Blocked) {
      return [
        maximumAuthority === Authority.Execution ? CycleOperationsCondition.Failed : CycleOperationsCondition.Waiting,
        CycleOperationsReason.LastCycleBlocked,
      ]
    }
    if (projection.last?.phase === CycleState.Completed) {
      return [CycleOperationsCondition.Waiting, CycleOperationsReason.LastCycleCompleted]
    }
    if (projection.last?.phase === CycleState.NoTrade) {
      return [CycleOperationsCondition.Waiting, CycleOperationsReason.LastCycleNoTrade]
    }
    return [CycleOperationsCondition.Waiting, CycleOperationsReason.NoCycleRecorded]
  }

  if (current.phase === CycleState.Pending) {
    if (nowMs >= Date.parse(current.submissionCutoffAt)) {
      return [CycleOperationsCondition.Stalled, CycleOperationsReason.MissedSubmissionCutoff]
    }
    if (current.snapshotId === null) {
      return nowMs >= Date.parse(current.submissionOpenAt)
        ? [CycleOperationsCondition.Stalled, CycleOperationsReason.MissedPublicationDeadline]
        : [CycleOperationsCondition.Waiting, CycleOperationsReason.AwaitingSignalPublication]
    }
    if (nowMs < Date.parse(current.submissionOpenAt)) {
      return [CycleOperationsCondition.Waiting, CycleOperationsReason.AwaitingSubmissionOpen]
    }
    const progressStartedAt = Math.max(Date.parse(current.updatedAt), Date.parse(current.submissionOpenAt))
    if (nowMs - progressStartedAt >= cycleStallThresholdMs) {
      return [CycleOperationsCondition.Stalled, CycleOperationsReason.AttemptStale]
    }
    return [CycleOperationsCondition.Running, CycleOperationsReason.AwaitingActivation]
  }

  if (current.phase === CycleState.Active) {
    if (current.decisionHash === null) {
      if (nowMs >= Date.parse(current.submissionCutoffAt)) {
        return [CycleOperationsCondition.Stalled, CycleOperationsReason.MissedSubmissionCutoff]
      }
      if (nowMs < Date.parse(current.submissionOpenAt)) {
        return [CycleOperationsCondition.Waiting, CycleOperationsReason.AwaitingSubmissionOpen]
      }
      return [CycleOperationsCondition.Running, CycleOperationsReason.AwaitingDecision]
    }
    if (nowMs >= Date.parse(current.executionCloseAt)) {
      return [CycleOperationsCondition.Stalled, CycleOperationsReason.MissedExecutionClose]
    }
    return [CycleOperationsCondition.Running, CycleOperationsReason.Active]
  }

  return [CycleOperationsCondition.Failed, CycleOperationsReason.MultipleUnfinishedCycles]
}

interface CycleOperationsDecisionFacts {
  readonly authorityMissing: boolean
  readonly authorityMaximumMismatch: boolean
  readonly killActive: boolean
  readonly reconciliationMissing: boolean
  readonly reconciliationDiscrepancy: boolean
  readonly reconciliationPredatesMutation: boolean
  readonly reconciliationStale: boolean
}

const decideCycleOperationsCondition = (
  projection: CycleOperationsProjection,
  nowMs: number,
  cycleStallThresholdMs: number,
  maximumAuthority: Authority,
  facts: CycleOperationsDecisionFacts,
): readonly [CycleOperationsCondition, CycleOperationsReason] => {
  if (projection.unfinishedCycleCount > 1) {
    return [CycleOperationsCondition.Failed, CycleOperationsReason.MultipleUnfinishedCycles]
  }
  if (
    projection.current?.phase === CycleState.Active &&
    projection.current.decisionHash === null &&
    nowMs >= Date.parse(projection.current.submissionCutoffAt)
  ) {
    return [CycleOperationsCondition.Stalled, CycleOperationsReason.MissedSubmissionCutoff]
  }
  if (facts.authorityMissing) return [CycleOperationsCondition.Failed, CycleOperationsReason.AuthorityMissing]
  if (facts.authorityMaximumMismatch) {
    return [CycleOperationsCondition.Failed, CycleOperationsReason.AuthorityMaximumMismatch]
  }
  if (facts.killActive) return [CycleOperationsCondition.Failed, CycleOperationsReason.KillActive]
  if (projection.mutations.unresolvedCount > 0) {
    return [CycleOperationsCondition.Failed, CycleOperationsReason.UnresolvedMutation]
  }
  if (facts.reconciliationMissing) {
    return [CycleOperationsCondition.Failed, CycleOperationsReason.ReconciliationMissing]
  }
  if (facts.reconciliationDiscrepancy) {
    return [CycleOperationsCondition.Failed, CycleOperationsReason.ReconciliationDiscrepancy]
  }
  if (facts.reconciliationPredatesMutation) {
    return [CycleOperationsCondition.Failed, CycleOperationsReason.ReconciliationPredatesMutation]
  }
  if (facts.reconciliationStale) {
    return [CycleOperationsCondition.Failed, CycleOperationsReason.ReconciliationStale]
  }
  return lifecycleCondition(projection, nowMs, cycleStallThresholdMs, maximumAuthority)
}

const deriveCycleOperationsStatusWithCheckedAt = (
  projection: CycleOperationsProjection,
  nowMs: number,
  maximumAuthority: Authority,
  thresholds: CycleOperationsThresholds,
  checkedAt: string,
): CycleOperationsStatus => {
  const attemptAgeMs = ageAt(projection.current?.updatedAt ?? null, nowMs)
  const oldestUnresolvedMutationAgeMs = ageAt(projection.mutations.oldestUnresolvedAt, nowMs)
  const reconciliationAgeMs = ageAt(projection.reconciliation?.reconciledAt ?? null, nowMs)
  const authorityMissing = maximumAuthority === Authority.Execution && projection.authority === null
  const authorityMaximumMismatch = projection.authority !== null && projection.authority.maximum !== maximumAuthority
  const authorityIncoherent = authorityMissing || authorityMaximumMismatch
  const killActive = projection.authority?.kill === KillState.Active
  const reconciliationMissing = maximumAuthority === Authority.Execution && projection.reconciliation === null
  const reconciliationDiscrepancy = projection.reconciliation?.status === ReconciliationStatus.Discrepancy
  const reconciliationCoversLatestMutation = projection.reconciliation?.coversLatestMutation ?? null
  const reconciliationPredatesMutation =
    maximumAuthority === Authority.Execution && reconciliationCoversLatestMutation === false
  const reconciliationStale =
    maximumAuthority === Authority.Execution &&
    reconciliationAgeMs !== null &&
    reconciliationAgeMs >= thresholds.reconciliationStaleThresholdMs
  const reconciliationBlocked =
    reconciliationMissing || reconciliationDiscrepancy || reconciliationPredatesMutation || reconciliationStale
  const unknownMutationStale =
    projection.mutations.unresolvedCount > 0 &&
    oldestUnresolvedMutationAgeMs !== null &&
    oldestUnresolvedMutationAgeMs >= thresholds.unknownMutationThresholdMs
  const [condition, reason] = decideCycleOperationsCondition(
    projection,
    nowMs,
    thresholds.cycleStallThresholdMs,
    maximumAuthority,
    {
      authorityMissing,
      authorityMaximumMismatch,
      killActive,
      reconciliationMissing,
      reconciliationDiscrepancy,
      reconciliationPredatesMutation,
      reconciliationStale,
    },
  )

  return {
    schemaVersion: 'bayn.cycle-operations-status.v1',
    ...projection,
    condition,
    reason,
    checkedAt,
    attemptAgeMs,
    oldestUnresolvedMutationAgeMs,
    reconciliationAgeMs,
    reconciliationCoversLatestMutation,
    zeroMutation: projection.mutations.eventCount === 0,
    alerts: {
      cycleStalled: condition === CycleOperationsCondition.Stalled,
      cycleFailed: condition === CycleOperationsCondition.Failed,
      unknownMutationStale,
      reconciliationBlocked,
      killActive,
      authorityIncoherent,
    },
    error: null,
  }
}

const deriveCycleOperationsStatusResultDataFirst = (
  projection: CycleOperationsProjection,
  nowMs: number,
  maximumAuthority: Authority,
  thresholds: CycleOperationsThresholds,
): Result.Result<CycleOperationsStatus, CycleOperationsStatusFailure> =>
  Result.map(
    Result.mapError(
      utcInstantFromEpochMillisResult(nowMs),
      (cause): CycleOperationsStatusFailure => ({ _tag: 'CycleOperationsClockInvalid', nowMs, cause }),
    ),
    (checkedAt) => deriveCycleOperationsStatusWithCheckedAt(projection, nowMs, maximumAuthority, thresholds, checkedAt),
  )

export const deriveCycleOperationsStatusResult = Pipeable.dual(4, deriveCycleOperationsStatusResultDataFirst)

const deriveCycleOperationsStatusDataFirst = (
  projection: CycleOperationsProjection,
  nowMs: number,
  maximumAuthority: Authority,
  thresholds: CycleOperationsThresholds,
): CycleOperationsStatus =>
  Result.getOrThrow(deriveCycleOperationsStatusResult(projection, nowMs, maximumAuthority, thresholds))

export const deriveCycleOperationsStatus = Pipeable.dual(4, deriveCycleOperationsStatusDataFirst)
