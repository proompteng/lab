import { Data, Result, Schema } from 'effect'

import {
  AutonomousCycleSchema,
  CycleState,
  CycleTerminalReason,
  cycleDraftMatches,
  cycleDraftOf,
  isTerminalCycleState,
  type ActiveDecisionBoundCycle,
  type ActiveUnboundCycle,
  type AutonomousCycle,
  type CycleCompletionState,
  type PendingCycle,
} from './cycle'
import type { CyclePublicationReadiness } from './cycle-readiness'
import { ObserveShadowDecisionDocumentSchema, type ObserveShadowDecisionDocument } from './shadow-decision-contract'
import {
  NonNegativeFiniteSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from './schemas'
import { TargetPlanReason, TargetPlanStatus, type BlockedTargetPlanReason } from './target-planner'

type WaitingReadiness = Extract<CyclePublicationReadiness, { readonly outcome: 'WAITING' }>
type BlockedReadiness = Extract<CyclePublicationReadiness, { readonly outcome: 'BLOCKED' }>
type BoundOrAlreadyReadiness = Extract<CyclePublicationReadiness, { readonly outcome: 'BOUND' | 'ALREADY_BOUND' }>
type BoundReadiness = Omit<BoundOrAlreadyReadiness, 'outcome'> & { readonly outcome: 'BOUND' }
type AlreadyBoundReadiness = Omit<BoundOrAlreadyReadiness, 'outcome'> & { readonly outcome: 'ALREADY_BOUND' }

const isAlreadyBoundReadiness = (readiness: CyclePublicationReadiness): readiness is AlreadyBoundReadiness =>
  readiness.outcome === 'ALREADY_BOUND'

export type CycleRecoverySelection =
  | { readonly action: 'DISCOVER' }
  | {
      readonly action: 'BLOCK'
      readonly cycleId: string
      readonly observedAt: string
      readonly reason: CycleTerminalReason
    }
  | { readonly action: 'READ_PUBLICATION'; readonly cycle: AutonomousCycle }
  | {
      readonly action: 'RETURN_READINESS'
      readonly result: WaitingReadiness
      readonly recoveryAction: 'WAITING'
    }
  | {
      readonly action: 'RETURN_READINESS'
      readonly result: BlockedReadiness
      readonly recoveryAction: 'BLOCKED'
    }
  | {
      readonly action: 'RETURN_READINESS'
      readonly result: BoundReadiness
      readonly recoveryAction: 'BOUND_SNAPSHOT'
    }
  | {
      readonly action: 'ACTIVATE'
      readonly cycleId: string
      readonly observedAt: string
    }
  | {
      readonly action: 'WAIT'
      readonly cycle: AutonomousCycle
      readonly observedAt: string
    }
  | { readonly action: 'BUILD_DECISION'; readonly cycle: AutonomousCycle }
  | { readonly action: 'READ_DECISION'; readonly cycle: AutonomousCycle }
  | {
      readonly action: 'FINISH'
      readonly cycleId: string
      readonly observedAt: string
      readonly state: CycleCompletionState
    }

export interface CycleRecoveryState {
  readonly qualificationRunId: string
  readonly accountId: string
  readonly strategyProtocolHash: string
  readonly observedAt: string
  readonly cycle: AutonomousCycle | undefined
  readonly readiness?: CyclePublicationReadiness
  readonly decisionDocument?: ObserveShadowDecisionDocument | null
}

type RecoveryScope = Pick<
  CycleRecoveryState,
  'accountId' | 'observedAt' | 'qualificationRunId' | 'strategyProtocolHash'
>

export type CorrelatedCycleRecoveryState =
  | (RecoveryScope & {
      readonly cycle?: undefined
      readonly readiness?: undefined
      readonly decisionDocument?: undefined
    })
  | (RecoveryScope & {
      readonly cycle: PendingCycle
      readonly readiness?: CyclePublicationReadiness
      readonly decisionDocument?: undefined
    })
  | (RecoveryScope & {
      readonly cycle: ActiveUnboundCycle
      readonly readiness?: undefined
      readonly decisionDocument?: undefined
    })
  | (RecoveryScope & {
      readonly cycle: ActiveDecisionBoundCycle
      readonly readiness?: undefined
      readonly decisionDocument?: ObserveShadowDecisionDocument | null
    })

interface DecodeRecoveryStateIssue {
  readonly operation: 'decode-state'
  readonly reason: 'decode'
}

interface SelectRecoveryIssue {
  readonly operation: 'select'
  readonly reason:
    | 'chronology'
    | 'decision-missing'
    | 'evidence-without-cycle'
    | 'readiness-binding'
    | 'scope'
    | 'state-evidence'
    | 'terminal-cycle'
}

interface ValidateRecoveryDecisionIssue {
  readonly operation: 'validate-decision'
  readonly reason: 'decision-binding'
}

type CycleRecoveryIssue = DecodeRecoveryStateIssue | SelectRecoveryIssue | ValidateRecoveryDecisionIssue

interface CycleRecoveryFailureDetails {
  readonly message: string
  readonly facts: Readonly<Record<string, unknown>>
  readonly cause?: unknown
}

const CycleRecoveryFailure = Data.TaggedError('CycleRecoveryFailure')<CycleRecoveryIssue & CycleRecoveryFailureDetails>
export type CycleRecoveryFailure = InstanceType<typeof CycleRecoveryFailure>

type CycleRecoveryReason<Operation extends CycleRecoveryIssue['operation']> = Extract<
  CycleRecoveryIssue,
  { readonly operation: Operation }
>['reason']

const decodeRecoveryStateFailure = (
  reason: CycleRecoveryReason<'decode-state'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleRecoveryFailure => new CycleRecoveryFailure({ operation: 'decode-state', reason, message, facts, cause })

const selectRecoveryFailure = (
  reason: CycleRecoveryReason<'select'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleRecoveryFailure => new CycleRecoveryFailure({ operation: 'select', reason, message, facts, cause })

const validateDecisionFailure = (
  reason: CycleRecoveryReason<'validate-decision'>,
  message: string,
  facts: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CycleRecoveryFailure => new CycleRecoveryFailure({ operation: 'validate-decision', reason, message, facts, cause })

const PublicationFreshnessSchema = Schema.Struct({
  dataAgeMs: NonNegativeFiniteSchema,
  publicationDelayMs: NonNegativeFiniteSchema,
})

const WaitingReadinessSchema = Schema.Struct({
  outcome: Schema.Literal('WAITING'),
  reason: Schema.Literals(['SIGNAL_SESSION_OPEN', 'PUBLICATION_MISSING']),
  observedAt: UtcInstantSchema,
  cycle: AutonomousCycleSchema,
})

const BoundReadinessSchema = Schema.Struct({
  outcome: Schema.Literals(['BOUND', 'ALREADY_BOUND']),
  observedAt: UtcInstantSchema,
  cycle: AutonomousCycleSchema,
  snapshotId: Sha256Schema,
  freshness: Schema.optionalKey(PublicationFreshnessSchema),
})

const BlockedReadinessSchema = Schema.Struct({
  outcome: Schema.Literal('BLOCKED'),
  observedAt: UtcInstantSchema,
  cycle: AutonomousCycleSchema,
})

const CyclePublicationReadinessSchema = Schema.Union([
  WaitingReadinessSchema,
  BoundReadinessSchema,
  BlockedReadinessSchema,
])

const CycleRecoveryStateSchema = Schema.Struct({
  qualificationRunId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  strategyProtocolHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  cycle: Schema.UndefinedOr(AutonomousCycleSchema),
  readiness: Schema.optionalKey(CyclePublicationReadinessSchema),
  decisionDocument: Schema.optionalKey(Schema.NullOr(ObserveShadowDecisionDocumentSchema)),
})

type DecodedCycleRecoveryState = typeof CycleRecoveryStateSchema.Type

const decodeCycleRecoveryStateResult = Schema.decodeUnknownResult(CycleRecoveryStateSchema, strictParseOptions)

const validateDecisionBinding = (
  cycle: AutonomousCycle,
  document: ObserveShadowDecisionDocument,
): Result.Result<void, CycleRecoveryFailure> => {
  const facts = {
    expectedAccountId: cycle.identity.accountId,
    actualAccountId: document.bindings.accountId,
    expectedCycleId: cycle.identity.cycleId,
    actualCycleId: document.bindings.cycleId,
    expectedCycleStateVersion: cycle.stateVersion,
    actualDocumentCreatedAt: document.createdAt,
    expectedDecisionHash: cycle.bindings.decisionHash,
    actualDecisionHash: document.contentHash,
    expectedSnapshotId: cycle.bindings.snapshotId,
    actualSnapshotId: document.bindings.snapshotId,
    expectedStrategyName: cycle.identity.strategyName,
    actualStrategyName: document.bindings.strategyName,
    expectedStrategyProtocolHash: cycle.identity.strategyProtocolHash,
    actualStrategyProtocolHash: document.bindings.strategyProtocolHash,
    expectedSubmissionCutoffAt: cycle.window.submissionCutoffAt,
    actualSubmissionCutoffAt: document.submissionCutoffAt,
    minimumCycleCreatedAt: cycle.createdAt,
    minimumSubmissionOpenAt: cycle.window.submissionOpenAt,
    maximumCycleUpdatedAt: cycle.updatedAt,
  }
  return cycle.bindings.decisionHash !== document.contentHash ||
    cycle.bindings.snapshotId !== document.bindings.snapshotId ||
    cycle.identity.cycleId !== document.bindings.cycleId ||
    cycle.identity.strategyName !== document.bindings.strategyName ||
    cycle.identity.strategyProtocolHash !== document.bindings.strategyProtocolHash ||
    cycle.identity.accountId !== document.bindings.accountId ||
    cycle.window.submissionCutoffAt !== document.submissionCutoffAt ||
    document.createdAt < cycle.createdAt ||
    document.createdAt < cycle.window.submissionOpenAt ||
    document.createdAt > cycle.updatedAt
    ? Result.fail(
        validateDecisionFailure(
          'decision-binding',
          'durable shadow decision does not match the active cycle binding',
          facts,
        ),
      )
    : Result.succeed(undefined)
}

export const cycleTerminalReasonForBlockedTargetPlan = (reason: BlockedTargetPlanReason): CycleTerminalReason => {
  switch (reason) {
    case TargetPlanReason.SubmissionCutoffReached:
      return CycleTerminalReason.MissedSubmission
    case TargetPlanReason.IdentityMismatch:
      return CycleTerminalReason.ProvenanceMismatch
    case TargetPlanReason.InputMismatch:
      return CycleTerminalReason.DataInvalid
    case TargetPlanReason.InputStale:
      return CycleTerminalReason.DataStale
    case TargetPlanReason.ReconciliationNotExact:
      return CycleTerminalReason.Reconciliation
    case TargetPlanReason.AccountNotActive:
      return CycleTerminalReason.BrokerDisabled
    case TargetPlanReason.UnknownOrder:
    case TargetPlanReason.UnresolvedOrder:
      return CycleTerminalReason.UnresolvedMutation
    case TargetPlanReason.BelowMinimumBuyNotional:
    case TargetPlanReason.InsufficientBuyingPower:
    case TargetPlanReason.NonPositiveEquity:
    case TargetPlanReason.ShortPositionNotAllowed:
      return CycleTerminalReason.Risk
  }
}

export const cycleCompletionStateForTargetPlan = (
  status: TargetPlanStatus.Planned | TargetPlanStatus.NoTrade,
): CycleCompletionState => {
  switch (status) {
    case TargetPlanStatus.Planned:
      return CycleState.Completed
    case TargetPlanStatus.NoTrade:
      return CycleState.NoTrade
  }
}

const selectBoundDecision = (
  cycle: AutonomousCycle,
  document: ObserveShadowDecisionDocument | null | undefined,
  observedAt: string,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
  if (document === undefined) return Result.succeed({ action: 'READ_DECISION', cycle })
  if (document === null) {
    return Result.fail(
      selectRecoveryFailure('decision-missing', 'decision-bound cycle is missing its durable document', {
        cycleId: cycle.identity.cycleId,
      }),
    )
  }
  return Result.flatMap(
    validateDecisionBinding(cycle, document),
    (): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
      switch (document.targetPlan.status) {
        case TargetPlanStatus.Planned:
        case TargetPlanStatus.NoTrade:
          return Result.succeed({
            action: 'FINISH',
            cycleId: cycle.identity.cycleId,
            observedAt,
            state: cycleCompletionStateForTargetPlan(document.targetPlan.status),
          })
        case TargetPlanStatus.Blocked:
          return Result.succeed({
            action: 'BLOCK',
            cycleId: cycle.identity.cycleId,
            observedAt,
            reason: cycleTerminalReasonForBlockedTargetPlan(document.targetPlan.reason),
          })
      }
    },
  )
}

const readinessBindingFacts = (
  cycle: AutonomousCycle,
  recoveryObservedAt: string,
  readiness: CyclePublicationReadiness,
): Readonly<Record<string, unknown>> => {
  const selectedSnapshotId = cycle.bindings.snapshotId
  const readinessSnapshotId = readiness.cycle.bindings.snapshotId
  const declaredSnapshotId =
    readiness.outcome === 'BOUND' || readiness.outcome === 'ALREADY_BOUND' ? readiness.snapshotId : undefined
  const expectedStateVersion =
    readiness.outcome === 'WAITING' || (readiness.outcome === 'ALREADY_BOUND' && selectedSnapshotId !== undefined)
      ? cycle.stateVersion
      : cycle.stateVersion + 1
  return {
    outcome: readiness.outcome,
    expectedAccountId: cycle.identity.accountId,
    actualAccountId: readiness.cycle.identity.accountId,
    expectedCycleId: cycle.identity.cycleId,
    actualCycleId: readiness.cycle.identity.cycleId,
    expectedQualificationRunId: cycle.identity.qualificationRunId,
    actualQualificationRunId: readiness.cycle.identity.qualificationRunId,
    expectedStrategyProtocolHash: cycle.identity.strategyProtocolHash,
    actualStrategyProtocolHash: readiness.cycle.identity.strategyProtocolHash,
    expectedSignalSessionDate: cycle.identity.signalSessionDate,
    actualSignalSessionDate: readiness.cycle.identity.signalSessionDate,
    expectedSignalCalendarVersion: cycle.identity.signalCalendarVersion,
    actualSignalCalendarVersion: readiness.cycle.identity.signalCalendarVersion,
    expectedSubmissionCutoffAt: cycle.window.submissionCutoffAt,
    actualSubmissionCutoffAt: readiness.cycle.window.submissionCutoffAt,
    expectedSelectedSnapshotId: selectedSnapshotId,
    actualSelectedSnapshotId: readinessSnapshotId,
    declaredSnapshotId,
    expectedState: readiness.outcome === 'BLOCKED' ? CycleState.Blocked : CycleState.Pending,
    actualState: readiness.cycle.state,
    selectedStateVersion: cycle.stateVersion,
    expectedStateVersion,
    actualStateVersion: readiness.cycle.stateVersion,
    selectedUpdatedAt: cycle.updatedAt,
    expectedMinimumReadinessObservedAt: recoveryObservedAt,
    actualReadinessObservedAt: readiness.observedAt,
    readinessObservedAt: readiness.observedAt,
    readinessCycleUpdatedAt: readiness.cycle.updatedAt,
  }
}

const readinessCommonMatches = (cycle: AutonomousCycle, readiness: CyclePublicationReadiness): boolean =>
  cycleDraftMatches(cycleDraftOf(cycle), cycleDraftOf(readiness.cycle)) &&
  readiness.cycle.identity.cycleId === cycle.identity.cycleId &&
  readiness.cycle.identity.accountId === cycle.identity.accountId &&
  readiness.cycle.identity.qualificationRunId === cycle.identity.qualificationRunId &&
  readiness.cycle.identity.strategyProtocolHash === cycle.identity.strategyProtocolHash &&
  readiness.cycle.window.submissionCutoffAt === cycle.window.submissionCutoffAt &&
  readiness.cycle.createdAt === cycle.createdAt &&
  readiness.observedAt >= cycle.updatedAt

const waitingReadinessMatches = (cycle: AutonomousCycle, readiness: WaitingReadiness): boolean =>
  cycle.bindings.snapshotId === undefined &&
  readiness.cycle.state === CycleState.Pending &&
  readiness.cycle.bindings.snapshotId === undefined &&
  readiness.cycle.bindings.decisionHash === undefined &&
  readiness.cycle.stateVersion === cycle.stateVersion &&
  readiness.cycle.updatedAt === cycle.updatedAt &&
  ((readiness.reason === 'SIGNAL_SESSION_OPEN' && readiness.observedAt < cycle.window.signalCloseAt) ||
    (readiness.reason === 'PUBLICATION_MISSING' &&
      readiness.observedAt >= cycle.window.signalCloseAt &&
      readiness.observedAt < cycle.window.publicationDeadlineAt))

const boundReadinessMatches = (cycle: AutonomousCycle, readiness: BoundOrAlreadyReadiness): boolean =>
  readiness.outcome === 'BOUND' &&
  cycle.bindings.snapshotId === undefined &&
  readiness.cycle.state === CycleState.Pending &&
  readiness.cycle.bindings.snapshotId === readiness.snapshotId &&
  readiness.cycle.bindings.decisionHash === undefined &&
  readiness.cycle.stateVersion === cycle.stateVersion + 1 &&
  readiness.cycle.updatedAt === readiness.observedAt &&
  readiness.observedAt >= cycle.window.signalCloseAt &&
  readiness.observedAt < cycle.window.publicationDeadlineAt

const alreadyBoundReadinessMatches = (cycle: AutonomousCycle, readiness: BoundOrAlreadyReadiness): boolean => {
  if (readiness.outcome !== 'ALREADY_BOUND') return false
  const unchangedBoundCycle =
    cycle.bindings.snapshotId === readiness.snapshotId &&
    readiness.cycle.stateVersion === cycle.stateVersion &&
    readiness.cycle.updatedAt === cycle.updatedAt
  const concurrentBinding =
    cycle.bindings.snapshotId === undefined &&
    readiness.cycle.stateVersion === cycle.stateVersion + 1 &&
    readiness.cycle.updatedAt > cycle.updatedAt &&
    readiness.cycle.updatedAt <= readiness.observedAt
  return (
    readiness.cycle.state === CycleState.Pending &&
    readiness.cycle.bindings.snapshotId === readiness.snapshotId &&
    readiness.cycle.bindings.decisionHash === undefined &&
    (unchangedBoundCycle || concurrentBinding)
  )
}

const blockedReadinessMatches = (cycle: AutonomousCycle, readiness: BlockedReadiness): boolean =>
  cycle.bindings.snapshotId === undefined &&
  readiness.cycle.state === CycleState.Blocked &&
  readiness.cycle.bindings.snapshotId === undefined &&
  readiness.cycle.bindings.decisionHash === undefined &&
  readiness.cycle.terminalReason === CycleTerminalReason.MissedPublication &&
  readiness.cycle.terminalAt === readiness.observedAt &&
  readiness.cycle.updatedAt === readiness.observedAt &&
  readiness.cycle.stateVersion === cycle.stateVersion + 1 &&
  readiness.observedAt >= cycle.window.publicationDeadlineAt

const readinessOutcomeMatches = (cycle: AutonomousCycle, readiness: CyclePublicationReadiness): boolean => {
  switch (readiness.outcome) {
    case 'WAITING':
      return waitingReadinessMatches(cycle, readiness)
    case 'BOUND':
      return boundReadinessMatches(cycle, readiness)
    case 'ALREADY_BOUND':
      return alreadyBoundReadinessMatches(cycle, readiness)
    case 'BLOCKED':
      return blockedReadinessMatches(cycle, readiness)
  }
}

const readinessIsCorrelated = (
  cycle: AutonomousCycle,
  recoveryObservedAt: string,
  readiness: CyclePublicationReadiness,
): boolean =>
  readiness.observedAt >= recoveryObservedAt &&
  readinessCommonMatches(cycle, readiness) &&
  readinessOutcomeMatches(cycle, readiness)

const validateReadiness = (
  cycle: AutonomousCycle,
  recoveryObservedAt: string,
  readiness: CyclePublicationReadiness,
): Result.Result<void, CycleRecoveryFailure> => {
  if (!readinessIsCorrelated(cycle, recoveryObservedAt, readiness)) {
    return Result.fail(
      selectRecoveryFailure(
        'readiness-binding',
        'publication readiness must be the permitted transition of the exact selected cycle draft and snapshot',
        readinessBindingFacts(cycle, recoveryObservedAt, readiness),
      ),
    )
  }
  return Result.succeed(undefined)
}

const validateRecoveryCycleContext = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): Result.Result<void, CycleRecoveryFailure> => {
  if (cycle.identity.qualificationRunId !== state.qualificationRunId || cycle.identity.accountId !== state.accountId) {
    return Result.fail(
      selectRecoveryFailure('scope', 'unfinished cycle does not match the configured recovery scope', {
        cycleId: cycle.identity.cycleId,
        expectedQualificationRunId: state.qualificationRunId,
        actualQualificationRunId: cycle.identity.qualificationRunId,
        expectedAccountId: state.accountId,
        actualAccountId: cycle.identity.accountId,
        cycleState: cycle.state,
        cycleStateVersion: cycle.stateVersion,
        submissionCutoffAt: cycle.window.submissionCutoffAt,
      }),
    )
  }
  if (isTerminalCycleState(cycle.state)) {
    return Result.fail(
      selectRecoveryFailure('terminal-cycle', 'terminal cycles must not enter autonomous recovery', {
        cycleId: cycle.identity.cycleId,
        state: cycle.state,
      }),
    )
  }
  if (state.observedAt < cycle.updatedAt) {
    return Result.fail(
      selectRecoveryFailure('chronology', 'recovery observation cannot precede the selected cycle update', {
        actualObservedAt: state.observedAt,
        expectedMinimumObservedAt: cycle.updatedAt,
        cycleId: cycle.identity.cycleId,
        cycleState: cycle.state,
        cycleStateVersion: cycle.stateVersion,
      }),
    )
  }
  return Result.succeed(undefined)
}

const selectDecisionBoundRecovery = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
  if (state.readiness !== undefined) {
    return Result.fail(
      selectRecoveryFailure('state-evidence', 'active cycle recovery does not accept publication readiness', {
        cycleId: cycle.identity.cycleId,
      }),
    )
  }
  return selectBoundDecision(cycle, state.decisionDocument, state.observedAt)
}

const correlatedReadinessOf = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): AlreadyBoundReadiness | undefined => {
  const { readiness } = state
  return readiness !== undefined &&
    isAlreadyBoundReadiness(readiness) &&
    readinessIsCorrelated(cycle, state.observedAt, readiness)
    ? readiness
    : undefined
}

const freshestRecoveryObservationAt = (
  state: DecodedCycleRecoveryState,
  readiness: AlreadyBoundReadiness | undefined,
): string =>
  readiness !== undefined && readiness.observedAt > state.observedAt ? readiness.observedAt : state.observedAt

const pendingSnapshotBindingAt = (
  cycle: AutonomousCycle,
  readiness: AlreadyBoundReadiness | undefined,
): string | undefined => {
  if (cycle.state !== CycleState.Pending) return undefined
  if (cycle.bindings.snapshotId !== undefined) return cycle.updatedAt
  return readiness?.cycle.updatedAt
}

const selectDeadlineOrProvenance = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): CycleRecoverySelection | undefined => {
  const correlatedReadiness = correlatedReadinessOf(state, cycle)
  const observedAt = freshestRecoveryObservationAt(state, correlatedReadiness)
  const pendingBindingEffectiveAt = pendingSnapshotBindingAt(cycle, correlatedReadiness)

  if (
    cycle.state === CycleState.Pending &&
    (pendingBindingEffectiveAt === undefined
      ? observedAt >= cycle.window.publicationDeadlineAt
      : pendingBindingEffectiveAt >= cycle.window.publicationDeadlineAt)
  ) {
    return {
      action: 'BLOCK',
      cycleId: cycle.identity.cycleId,
      observedAt,
      reason: CycleTerminalReason.MissedPublication,
    }
  }
  if (
    (cycle.state === CycleState.Active || pendingBindingEffectiveAt !== undefined) &&
    observedAt >= cycle.window.submissionCutoffAt
  ) {
    return {
      action: 'BLOCK',
      cycleId: cycle.identity.cycleId,
      observedAt,
      reason: CycleTerminalReason.MissedSubmission,
    }
  }
  if (cycle.identity.strategyProtocolHash !== state.strategyProtocolHash) {
    return {
      action: 'BLOCK',
      cycleId: cycle.identity.cycleId,
      observedAt: state.observedAt,
      reason: CycleTerminalReason.ProvenanceMismatch,
    }
  }
  return undefined
}

const selectActiveRecovery = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
  if (state.readiness !== undefined) {
    return Result.fail(
      selectRecoveryFailure('state-evidence', 'active cycle recovery does not accept publication readiness', {
        cycleId: cycle.identity.cycleId,
      }),
    )
  }
  if (state.decisionDocument !== undefined) {
    return Result.fail(
      selectRecoveryFailure('state-evidence', 'unbound active cycle cannot have durable decision evidence', {
        cycleId: cycle.identity.cycleId,
      }),
    )
  }
  return state.observedAt < cycle.window.submissionOpenAt
    ? Result.succeed({ action: 'WAIT', cycle, observedAt: state.observedAt })
    : Result.succeed({ action: 'BUILD_DECISION', cycle })
}

const selectPendingReadiness = (
  cycle: AutonomousCycle,
  recoveryObservedAt: string,
  readiness: CyclePublicationReadiness,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> =>
  Result.map(validateReadiness(cycle, recoveryObservedAt, readiness), () => {
    switch (readiness.outcome) {
      case 'WAITING':
        return { action: 'RETURN_READINESS', recoveryAction: 'WAITING', result: readiness }
      case 'BLOCKED':
        return { action: 'RETURN_READINESS', recoveryAction: 'BLOCKED', result: readiness }
      case 'BOUND':
        return {
          action: 'RETURN_READINESS',
          recoveryAction: 'BOUND_SNAPSHOT',
          result: { ...readiness, outcome: 'BOUND' },
        }
      case 'ALREADY_BOUND':
        return {
          action: 'ACTIVATE',
          cycleId: readiness.cycle.identity.cycleId,
          observedAt: readiness.observedAt,
        }
    }
  })

const selectPendingRecovery = (
  state: DecodedCycleRecoveryState,
  cycle: AutonomousCycle,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
  if (state.decisionDocument !== undefined) {
    return Result.fail(
      selectRecoveryFailure('state-evidence', 'pending cycle recovery does not accept decision evidence', {
        cycleId: cycle.identity.cycleId,
      }),
    )
  }
  return state.readiness === undefined
    ? Result.succeed({ action: 'READ_PUBLICATION', cycle })
    : selectPendingReadiness(cycle, state.observedAt, state.readiness)
}

const selectDecodedCycleRecovery = (
  state: DecodedCycleRecoveryState,
): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> => {
  const { cycle } = state
  if (cycle === undefined) {
    if (state.readiness !== undefined || state.decisionDocument !== undefined) {
      return Result.fail(
        selectRecoveryFailure('evidence-without-cycle', 'recovery evidence requires an unfinished cycle'),
      )
    }
    return Result.succeed({ action: 'DISCOVER' })
  }
  const cycleContext = validateRecoveryCycleContext(state, cycle)
  if (Result.isFailure(cycleContext)) return Result.fail(cycleContext.failure)
  if (cycle.state === CycleState.Active && cycle.bindings.decisionHash !== undefined) {
    return selectDecisionBoundRecovery(state, cycle)
  }
  const deadlineOrProvenance = selectDeadlineOrProvenance(state, cycle)
  if (deadlineOrProvenance !== undefined) return Result.succeed(deadlineOrProvenance)
  switch (cycle.state) {
    case CycleState.Active:
      return selectActiveRecovery(state, cycle)
    case CycleState.Pending:
      return selectPendingRecovery(state, cycle)
    default:
      return Result.fail(
        selectRecoveryFailure('state-evidence', `unsupported unfinished cycle state ${cycle.state}`, {
          cycleId: cycle.identity.cycleId,
          state: cycle.state,
        }),
      )
  }
}

export const selectCycleRecovery = (state: unknown): Result.Result<CycleRecoverySelection, CycleRecoveryFailure> =>
  Result.flatMap(
    Result.mapError(decodeCycleRecoveryStateResult(state), (cause) =>
      decodeRecoveryStateFailure('decode', 'autonomous cycle recovery state is invalid', {}, cause),
    ),
    selectDecodedCycleRecovery,
  )
