import { Schema } from 'effect'

import type { RuntimeProvenance } from './contracts'
import {
  CycleOperationsCondition,
  MonthEndCadenceCondition,
  MonthEndCadenceReason,
  type CycleOperationsStatus,
  unknownCycleOperationsStatus,
} from './cycle-observability'
import type { QualificationResult } from './qualification'
import type { RetainedAutonomousCyclePassObservation } from './cycle-runner/pass-decisions'
import { CycleNotDueReason } from './cycle-runner/model'
import { IsoDateSchema, UtcInstantSchema } from './schemas'
import type { EvaluationSummary, ReconciliationResult } from './types'

export interface RuntimePersistenceReceipt {
  readonly runId: string
  readonly deduplicated: boolean
  readonly artifactCount: number
  readonly eventCount: number
  readonly gateCount: number
}

export interface RuntimeEvidence {
  readonly startupMode: 'evaluated' | 'pinned' | 'recovered'
  readonly provenance: RuntimeProvenance
  readonly evaluation: EvaluationSummary
  readonly reconciliation: ReconciliationResult
  readonly persistence: RuntimePersistenceReceipt
  readonly qualification: QualificationResult
}

export interface DependencyHealth {
  readonly status: 'UNKNOWN' | 'AVAILABLE' | 'UNAVAILABLE'
  readonly checkedAt: string | null
  readonly error: string | null
}

export interface RuntimeHealth {
  readonly sequence: number
  readonly checkedAt: string | null
  readonly dependencies: {
    readonly postgresql: DependencyHealth
    readonly signal: DependencyHealth
    readonly tigerBeetle: DependencyHealth
    readonly evidence: DependencyHealth
    readonly cycle: DependencyHealth
    readonly cycleRunner: DependencyHealth
  }
}

export interface BrokerConfiguration {
  readonly expectedAccountId: string
  readonly executionEligible: boolean
  readonly executionDisabledReason: string | null
}

export interface BrokerStatus extends BrokerConfiguration {
  readonly configured: true
  readonly accountId: string | null
  readonly accountBound: boolean | null
  readonly readAvailable: boolean | null
  readonly checkedAt: string | null
  readonly error: string | null
}

export const MonthEndCadenceDecisionSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.month-end-cadence-decision.v1'),
  condition: Schema.Literals([
    MonthEndCadenceCondition.Due,
    MonthEndCadenceCondition.ExpectedWait,
    MonthEndCadenceCondition.Unknown,
  ]),
  reason: Schema.Literals([
    MonthEndCadenceReason.SignalAndExecutionSessionSameMonth,
    MonthEndCadenceReason.SignalToExecutionMonthTransition,
    MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence,
  ]),
  signalSessionDate: Schema.NullOr(IsoDateSchema),
  executionSessionDate: Schema.NullOr(IsoDateSchema),
  nextEligibility: Schema.Union([
    Schema.Struct({
      status: Schema.Literal('PROVEN'),
      sessionDate: IsoDateSchema,
      basis: Schema.Literal('EXECUTION_SESSION_MONTH_TRANSITION'),
    }),
    Schema.Struct({
      status: Schema.Literal('UNKNOWN'),
      reason: Schema.Literals([
        MonthEndCadenceReason.FutureCalendarEvidenceUnavailable,
        MonthEndCadenceReason.InvalidOrInsufficientCalendarEvidence,
      ]),
    }),
  ]),
})

export const AutonomousCyclePassObservationSchema = Schema.Union([
  Schema.Struct({
    result: Schema.Literal('SUCCESS'),
    observedAt: UtcInstantSchema,
    outcome: Schema.Literals([
      'NO_PUBLICATION',
      'ALREADY_ACQUIRED',
      'ALREADY_TERMINAL',
      'RESUMED',
      'RECOVERED',
      'NOT_DUE',
      'ACQUIRED',
      'REACQUIRED',
    ]),
    notDueReason: Schema.optionalKey(Schema.Enum(CycleNotDueReason)),
    cadenceDecision: Schema.optionalKey(MonthEndCadenceDecisionSchema),
  }),
  Schema.Struct({
    result: Schema.Literal('FAILURE'),
    observedAt: UtcInstantSchema,
    operation: Schema.Literals([
      'acquire-cycle',
      'bind-publication',
      'build-decision',
      'build-cycle',
      'configure',
      'inspect-publication',
      'load-context',
      'market-calendar',
      'read-oldest-unfinished',
      'read-authority-slot',
      'reconcile-not-due',
      'recover-cycle',
      'run-cycle-pass',
      'select-session',
    ]),
    failure: Schema.Literals([
      'calendar-read',
      'calendar-unavailable',
      'context',
      'contract',
      'database',
      'invalid-config',
      'market-data',
      'operational',
      'store',
    ]),
    message: Schema.NonEmptyString,
  }),
])

export type AutonomousCyclePassObservation = RetainedAutonomousCyclePassObservation

export interface AutonomousCycleLoopStatus {
  readonly configured: boolean
  readonly owner?: 'Process' | 'Restate'
  readonly startedAt: string | null
  readonly lastPass: AutonomousCyclePassObservation | null
}

export type PaperActivationRuntimeState =
  | { readonly _tag: 'NotConfigured' }
  | {
      readonly _tag: 'Pending'
      readonly requestHash: string | null
      readonly reason: 'REQUEST_INVALID' | 'STARTUP_EVIDENCE_UNAVAILABLE' | 'PREPARATION_FAILED' | 'REQUEST_EXPIRED'
    }
  | {
      readonly _tag: 'Realized'
      readonly requestHash: string
      readonly generationHash: string
      readonly grant: 'Qualified' | 'Research'
      readonly cutoffAt: string
      readonly expiresAt: string
      readonly maximumCloseSessions: number | null
    }
  | {
      readonly _tag: 'Completed'
      readonly requestHash: string
      readonly generationHash: string
      readonly grant: 'Qualified' | 'Research'
      readonly receiptHash: string
    }

export interface RuntimeState {
  readonly status: 'STARTING' | 'READY' | 'DEGRADED' | 'FAILED'
  readonly evidence: RuntimeEvidence | null
  readonly health: RuntimeHealth
  readonly cycle: CycleOperationsStatus
  readonly autonomousCycleLoop: AutonomousCycleLoopStatus
  readonly paperActivation?: PaperActivationRuntimeState
  readonly broker: BrokerStatus | null
  readonly error: string | null
}

const unknownDependency = (): DependencyHealth => ({ status: 'UNKNOWN', checkedAt: null, error: null })

export interface InitialRuntimeStateInput {
  readonly broker?: BrokerConfiguration | undefined
  readonly autonomousCycleLoopConfigured?: boolean
  readonly autonomousCycleLoopOwner?: 'Process' | 'Restate'
}

export const initialState = (input: InitialRuntimeStateInput): RuntimeState => ({
  status: 'STARTING',
  evidence: null,
  health: {
    sequence: 0,
    checkedAt: null,
    dependencies: {
      postgresql: unknownDependency(),
      signal: unknownDependency(),
      tigerBeetle: unknownDependency(),
      evidence: unknownDependency(),
      cycle: unknownDependency(),
      cycleRunner: unknownDependency(),
    },
  },
  cycle: unknownCycleOperationsStatus(),
  autonomousCycleLoop: {
    configured: input.autonomousCycleLoopConfigured ?? false,
    owner: input.autonomousCycleLoopOwner ?? 'Process',
    startedAt: null,
    lastPass: null,
  },
  paperActivation: { _tag: 'NotConfigured' },
  broker:
    input.broker === undefined
      ? null
      : {
          configured: true,
          expectedAccountId: input.broker.expectedAccountId,
          executionEligible: input.broker.executionEligible,
          executionDisabledReason: input.broker.executionDisabledReason,
          accountId: null,
          accountBound: null,
          readAvailable: null,
          checkedAt: null,
          error: null,
        },
  error: null,
})

export const qualificationEvidenceSatisfied = (state: RuntimeState): boolean =>
  state.evidence !== null ||
  ((state.paperActivation?._tag === 'Realized' || state.paperActivation?._tag === 'Completed') &&
    state.paperActivation.grant === 'Research')

export const isReady = (state: RuntimeState): boolean =>
  state.status === 'READY' &&
  qualificationEvidenceSatisfied(state) &&
  state.cycle.condition !== CycleOperationsCondition.Unknown &&
  state.cycle.condition !== CycleOperationsCondition.Stalled &&
  state.cycle.condition !== CycleOperationsCondition.Failed &&
  state.autonomousCycleLoop.lastPass?.result !== 'FAILURE' &&
  (state.broker === null || (state.broker.accountBound === true && state.broker.readAvailable === true)) &&
  Object.values(state.health.dependencies).every((dependency) => dependency.status === 'AVAILABLE')
