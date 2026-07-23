import { Authority, KillState, ReconciliationStatus } from './paper'
import { CycleState, type CycleTerminalReason } from './cycle'

export interface CycleOperationsThresholds {
  readonly cycleStallThresholdMs: number
  readonly reconciliationStaleThresholdMs: number
  readonly unknownMutationThresholdMs: number
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
}

export interface MutationObservation {
  readonly eventCount: number
  readonly unresolvedCount: number
  readonly oldestUnresolvedAt: string | null
  readonly latestOccurredAt: string | null
}

export interface CycleOperationsProjection {
  readonly current: CycleOperationsSnapshot | null
  readonly last: CycleOperationsSnapshot | null
  readonly unfinishedCycleCount: number
  readonly authority: DurableAuthorityObservation | null
  readonly reconciliation: ReconciliationObservation | null
  readonly mutations: MutationObservation
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
): readonly [CycleOperationsCondition, CycleOperationsReason] => {
  if (projection.last?.phase === CycleState.Blocked) {
    return [CycleOperationsCondition.Failed, CycleOperationsReason.LastCycleBlocked]
  }

  const current = projection.current
  if (current === null) {
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
    if (nowMs >= Date.parse(current.executionCloseAt)) {
      return [CycleOperationsCondition.Stalled, CycleOperationsReason.MissedExecutionClose]
    }
    return [CycleOperationsCondition.Running, CycleOperationsReason.Active]
  }

  return [CycleOperationsCondition.Failed, CycleOperationsReason.MultipleUnfinishedCycles]
}

export const deriveCycleOperationsStatus = (
  projection: CycleOperationsProjection,
  nowMs: number,
  maximumAuthority: Authority,
  thresholds: CycleOperationsThresholds,
): CycleOperationsStatus => {
  const checkedAt = new Date(nowMs).toISOString()
  const attemptAgeMs = ageAt(projection.current?.updatedAt ?? null, nowMs)
  const oldestUnresolvedMutationAgeMs = ageAt(projection.mutations.oldestUnresolvedAt, nowMs)
  const reconciliationAgeMs = ageAt(projection.reconciliation?.reconciledAt ?? null, nowMs)
  const authorityMissing = maximumAuthority === Authority.Paper && projection.authority === null
  const authorityMaximumMismatch = projection.authority !== null && projection.authority.maximum !== maximumAuthority
  const authorityIncoherent = authorityMissing || authorityMaximumMismatch
  const killActive = projection.authority?.kill === KillState.Active
  const reconciliationMissing = maximumAuthority === Authority.Paper && projection.reconciliation === null
  const reconciliationDiscrepancy = projection.reconciliation?.status === ReconciliationStatus.Discrepancy
  const reconciliationCoversLatestMutation =
    projection.reconciliation === null
      ? null
      : projection.mutations.latestOccurredAt === null ||
        Date.parse(projection.reconciliation.reconciledAt) >= Date.parse(projection.mutations.latestOccurredAt)
  const reconciliationPredatesMutation =
    maximumAuthority === Authority.Paper && reconciliationCoversLatestMutation === false
  const reconciliationStale =
    maximumAuthority === Authority.Paper &&
    reconciliationAgeMs !== null &&
    reconciliationAgeMs >= thresholds.reconciliationStaleThresholdMs
  const reconciliationBlocked =
    reconciliationMissing || reconciliationDiscrepancy || reconciliationPredatesMutation || reconciliationStale
  const unknownMutationStale =
    projection.mutations.unresolvedCount > 0 &&
    oldestUnresolvedMutationAgeMs !== null &&
    oldestUnresolvedMutationAgeMs >= thresholds.unknownMutationThresholdMs

  let condition: CycleOperationsCondition
  let reason: CycleOperationsReason
  if (projection.unfinishedCycleCount > 1) {
    condition = CycleOperationsCondition.Failed
    reason = CycleOperationsReason.MultipleUnfinishedCycles
  } else if (authorityMissing) {
    condition = CycleOperationsCondition.Failed
    reason = CycleOperationsReason.AuthorityMissing
  } else if (authorityMaximumMismatch) {
    condition = CycleOperationsCondition.Failed
    reason = CycleOperationsReason.AuthorityMaximumMismatch
  } else if (killActive) {
    condition = CycleOperationsCondition.Failed
    reason = CycleOperationsReason.KillActive
  } else if (projection.mutations.unresolvedCount > 0) {
    condition = CycleOperationsCondition.Failed
    reason = CycleOperationsReason.UnresolvedMutation
  } else if (reconciliationMissing) {
    condition = CycleOperationsCondition.Failed
    reason = CycleOperationsReason.ReconciliationMissing
  } else if (reconciliationDiscrepancy) {
    condition = CycleOperationsCondition.Failed
    reason = CycleOperationsReason.ReconciliationDiscrepancy
  } else if (reconciliationPredatesMutation) {
    condition = CycleOperationsCondition.Failed
    reason = CycleOperationsReason.ReconciliationPredatesMutation
  } else if (reconciliationStale) {
    condition = CycleOperationsCondition.Failed
    reason = CycleOperationsReason.ReconciliationStale
  } else {
    ;[condition, reason] = lifecycleCondition(projection, nowMs, thresholds.cycleStallThresholdMs)
  }

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
