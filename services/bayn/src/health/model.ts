import type { Effect } from 'effect'

import type { BrokerReadShape } from '../broker/alpaca'
import type { RuntimeConfig } from '../config'
import type { CycleOperationsProjection } from '../cycle/observability'
import type { CycleObservabilityShape } from '../cycle/store'
import type { DatabaseError } from '../db/database-error'
import type { ExecutionControllerStatus, ExecutionControllerStatusStoreShape } from '../execution/controller-status'
import type { JournalService } from '../ledger'
import type { IntradayMarketDataService } from '../market-data'
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
  readonly signal: ProbeResult<void>
  readonly tigerBeetle: ProbeResult<void>
  readonly cycle: ProbeResult<CycleOperationsProjection>
  readonly broker: ProbeResult<BrokerHealthObservation> | null
  readonly executionController?: ProbeResult<ExecutionControllerStatus | null> | null
}

export interface ExecutionControllerProbe {
  readonly controllerKey: string
  readonly read: ExecutionControllerStatusStoreShape['read']
}

export interface HealthDependencies {
  readonly marketData: IntradayMarketDataService
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
