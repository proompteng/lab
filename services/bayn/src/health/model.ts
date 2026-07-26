import type { BrokerReadShape } from '../broker/alpaca'
import type { RuntimeConfig } from '../config'
import type { CycleOperationsProjection } from '../cycle-observability'
import type { QualificationRecord } from '../db/evidence-store'
import type { CanonicalHashFailure } from '../hash'
import type { BrokerConfiguration, RuntimeHealth, RuntimeState } from '../runtime-state'

export type ProbeResult<A> =
  | { readonly _tag: 'Available'; readonly value: A }
  | { readonly _tag: 'Unavailable'; readonly error: string }

export interface HealthProbeResults {
  readonly postgresql: ProbeResult<void>
  readonly signal: ProbeResult<void>
  readonly tigerBeetle: ProbeResult<void>
  readonly durableEvidence: ProbeResult<void>
  readonly cycle: ProbeResult<CycleOperationsProjection>
  readonly broker: ProbeResult<string> | null
}

export type SignalIdentityFailure =
  | { readonly _tag: 'EvidenceUnavailable' }
  | {
      readonly _tag: 'SnapshotMismatch'
      readonly observedSnapshotId: string
      readonly expectedSnapshotId: string
    }
  | {
      readonly _tag: 'PublicationMismatch'
      readonly observedPublicationId: string
      readonly expectedPublicationId: string
    }

export type DurableEvidenceFailure =
  | { readonly _tag: 'EvidenceUnavailable' }
  | { readonly _tag: 'RunMissing'; readonly runId: string }
  | {
      readonly _tag: 'TerminalQualificationMissing'
      readonly runId: string
      readonly observedState: Exclude<QualificationRecord['state'], 'TERMINAL'> | null
    }
  | {
      readonly _tag: 'RunMismatch'
      readonly runId: string
      readonly observedDurableHash: string
      readonly expectedDurableHash: string
    }
  | {
      readonly _tag: 'TerminalQualificationMismatch'
      readonly runId: string
      readonly observedQualificationHash: string
      readonly expectedQualificationHash: string
    }
  | {
      readonly _tag: 'CanonicalizationFailed'
      readonly runId: string
      readonly material:
        | 'EXPECTED_DURABLE_EVIDENCE'
        | 'OBSERVED_DURABLE_EVIDENCE'
        | 'EXPECTED_QUALIFICATION'
        | 'OBSERVED_QUALIFICATION'
      readonly cause: CanonicalHashFailure
    }

export type HealthDependencyName = keyof RuntimeHealth['dependencies'] | 'broker'

export type AutonomousCycleFiberObservation =
  | { readonly _tag: 'NotProvided' }
  | { readonly _tag: 'Running' }
  | { readonly _tag: 'ExitedSuccessfully' }
  | { readonly _tag: 'ExitedWithFailure'; readonly error: string }

export interface HealthTransitionInput {
  readonly config: RuntimeConfig
  readonly evidenceAvailable: boolean
  readonly results: HealthProbeResults
  readonly broker: BrokerConfiguration | undefined
  readonly cycleFiber: AutonomousCycleFiberObservation
  readonly checkedAt: string
  readonly checkedAtMs: number
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
  readonly checkedAt: string
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
