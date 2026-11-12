import type { Effect } from 'effect'

import type { BrokerReadShape } from '../broker/alpaca/model'
import type { RuntimeConfig } from '../config/model'
import type { CycleOperationsProjection } from '../cycle/observability'
import type { CycleObservabilityShape } from '../cycle/store/observability'
import type { DatabaseError } from '../db/database-error'
import type { ExecutionControllerStatus, ExecutionControllerStatusStoreError } from '../execution/controller-status'
import type { ExecutionControllerHealth } from '../execution/controller-health'
import type { OperationalError } from '../errors'
import type { JournalService } from '../ledger'
import type { IntradayMarketDataService } from '../market-data/intraday/model'
import type { BrokerConfiguration, RuntimeHealth, RuntimeState } from '../runtime-state'
import type { UtcEpochMillisFailure } from '../time'

export type ProbeResult<A> =
  | { readonly _tag: 'Available'; readonly value: A }
  | { readonly _tag: 'Unavailable'; readonly error: string }

export type CycleObservationBinding =
  | { readonly _tag: 'Exact'; readonly bindingId: string }
  | { readonly _tag: 'Unavailable' }

export interface BrokerHealthObservation {
  readonly accountId: string
  readonly permissionError: string | null
}

export interface HealthProbeResults {
  readonly postgresql: ProbeResult<void>
  readonly signal?: ProbeResult<void>
  readonly tigerBeetle: ProbeResult<void>
  readonly cycle: ProbeResult<CycleOperationsProjection>
  readonly broker: ProbeResult<BrokerHealthObservation> | null
  readonly executionController?: ProbeResult<ExecutionControllerHealthObservation> | null
}

export interface ExecutionControllerHealthObservation {
  readonly operational: ExecutionControllerHealth | null
  readonly status: ExecutionControllerStatus | null
}

export interface ExecutionControllerProbe {
  readonly controllerKey: string
  readonly read: (
    controllerKey: string,
  ) => Effect.Effect<ExecutionControllerHealthObservation, ExecutionControllerStatusStoreError | OperationalError>
}

export interface HealthDependencies {
  readonly marketData?: Pick<IntradayMarketDataService, 'check'>
  readonly journal: JournalService
  readonly postgresql: Effect.Effect<void, DatabaseError>
  readonly cycleObservability: CycleObservabilityShape
}

export type HealthDependencyName = keyof RuntimeHealth['dependencies'] | 'broker'

export type AutonomousCycleFiberObservation =
  | { readonly _tag: 'NotProvided' }
  | { readonly _tag: 'Running' }
  | { readonly _tag: 'ExitedSuccessfully' }
  | { readonly _tag: 'ExitedWithFailure'; readonly error: string }

export type HealthProbeClock =
  | {
      readonly _tag: 'Available'
      readonly checkedAt: string
      readonly checkedAtMs: number
    }
  | {
      readonly _tag: 'Unavailable'
      readonly observedAtMs: number
      readonly failure: UtcEpochMillisFailure
    }

export interface HealthTransitionInput {
  readonly config: RuntimeConfig
  readonly results: HealthProbeResults
  readonly broker: BrokerConfiguration | undefined
  readonly cycleFiber: AutonomousCycleFiberObservation
  readonly clock: HealthProbeClock
}

export interface HealthFailureSummary {
  readonly failedDependencies: readonly HealthDependencyName[]
  readonly messages: readonly string[]
}

export interface HealthTransition {
  readonly current: RuntimeState
  readonly next: RuntimeState
  readonly health: RuntimeHealth
  readonly failedDependencies: readonly HealthDependencyName[]
  readonly checkedAt: string | null
  readonly clockFailure: UtcEpochMillisFailure | null
}

export type LogAnnotation = string | number | boolean

export interface HealthLogDecision {
  readonly _tag: 'RuntimeStatusChanged' | 'CycleOperationsChanged'
  readonly level: 'INFO' | 'WARNING'
  readonly message: string
  readonly annotations: Readonly<Record<string, LogAnnotation>>
}

export interface BrokerProbe extends BrokerConfiguration {
  readonly read: BrokerReadShape
}
