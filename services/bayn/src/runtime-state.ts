import type { RuntimeProvenance } from './contracts'
import type { QualificationResult } from './qualification'
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

export interface RuntimeState {
  readonly status: 'STARTING' | 'READY' | 'DEGRADED' | 'FAILED'
  readonly evidence: RuntimeEvidence | null
  readonly health: RuntimeHealth
  readonly broker: BrokerStatus | null
  readonly error: string | null
}

const unknownDependency = (): DependencyHealth => ({ status: 'UNKNOWN', checkedAt: null, error: null })

export const initialState = (broker?: BrokerConfiguration): RuntimeState => ({
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
    },
  },
  broker:
    broker === undefined
      ? null
      : {
          configured: true,
          expectedAccountId: broker.expectedAccountId,
          executionEligible: broker.executionEligible,
          executionDisabledReason: broker.executionDisabledReason,
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
  state.evidence !== null &&
  (state.broker === null || (state.broker.accountBound === true && state.broker.readAvailable === true)) &&
  Object.values(state.health.dependencies).every((dependency) => dependency.status === 'AVAILABLE')
