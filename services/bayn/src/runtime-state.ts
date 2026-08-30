import type { ExecutionControllerStatus } from './execution/controller-status'
import {
  CycleOperationsCondition,
  type CycleOperationsStatus,
  unknownCycleOperationsStatus,
} from './cycle/observability'
import {
  RetainedAutonomousCyclePassObservationSchema,
  type RetainedAutonomousCyclePassObservation,
} from './cycle/runner/pass-observation'

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

export const AutonomousCyclePassObservationSchema = RetainedAutonomousCyclePassObservationSchema

export type AutonomousCyclePassObservation = RetainedAutonomousCyclePassObservation

export interface AutonomousCycleLoopStatus {
  readonly configured: boolean
  readonly owner?: 'Process' | 'Restate'
  readonly startedAt: string | null
  readonly lastPass: AutonomousCyclePassObservation | null
}

export interface ExecutionControllerRuntimeStatus {
  readonly configured: true
  readonly controllerKey: string
  readonly planHash: string
  readonly status: ExecutionControllerStatus | null
  readonly readAvailable: boolean | null
  readonly checkedAt: string | null
  readonly error: string | null
}

export type CapitalActivationRuntimeState =
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
      readonly grant: 'Research'
      readonly cutoffAt: string
      readonly expiresAt: string
      readonly maximumCloseSessions: number | null
    }
  | {
      readonly _tag: 'Completed'
      readonly requestHash: string
      readonly generationHash: string
      readonly grant: 'Research'
      readonly receiptHash: string
    }

export interface RuntimeState {
  readonly status: 'STARTING' | 'READY' | 'DEGRADED' | 'FAILED'
  readonly health: RuntimeHealth
  readonly cycle: CycleOperationsStatus
  readonly autonomousCycleLoop: AutonomousCycleLoopStatus
  readonly executionController?: ExecutionControllerRuntimeStatus
  readonly capitalActivation?: CapitalActivationRuntimeState
  readonly broker: BrokerStatus | null
  readonly error: string | null
}

const unknownDependency = (): DependencyHealth => ({ status: 'UNKNOWN', checkedAt: null, error: null })

export interface InitialRuntimeStateInput {
  readonly broker?: BrokerConfiguration | undefined
  readonly autonomousCycleLoopConfigured?: boolean
  readonly autonomousCycleLoopOwner?: 'Process' | 'Restate'
  readonly executionController?: {
    readonly controllerKey: string
    readonly planHash: string
  }
}

export const initialState = (input: InitialRuntimeStateInput): RuntimeState => ({
  status: 'STARTING',
  health: {
    sequence: 0,
    checkedAt: null,
    dependencies: {
      postgresql: unknownDependency(),
      signal: unknownDependency(),
      tigerBeetle: unknownDependency(),
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
  ...(input.executionController === undefined
    ? {}
    : {
        executionController: {
          configured: true as const,
          controllerKey: input.executionController.controllerKey,
          planHash: input.executionController.planHash,
          status: null,
          readAvailable: null,
          checkedAt: null,
          error: null,
        },
      }),
  capitalActivation: { _tag: 'NotConfigured' },
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

export const isReady = (state: RuntimeState): boolean =>
  state.status === 'READY' &&
  state.capitalActivation?._tag !== 'Pending' &&
  state.cycle.condition !== CycleOperationsCondition.Unknown &&
  state.cycle.condition !== CycleOperationsCondition.Stalled &&
  state.cycle.condition !== CycleOperationsCondition.Failed &&
  state.autonomousCycleLoop.lastPass?.result !== 'FAILURE' &&
  (state.broker === null || (state.broker.accountBound === true && state.broker.readAvailable === true)) &&
  Object.values(state.health.dependencies).every((dependency) => dependency.status === 'AVAILABLE')
