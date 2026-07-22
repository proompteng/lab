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

export interface RuntimeState {
  readonly status: 'STARTING' | 'READY' | 'DEGRADED' | 'FAILED'
  readonly evidence: RuntimeEvidence | null
  readonly health: RuntimeHealth
  readonly error: string | null
}

const unknownDependency = (): DependencyHealth => ({ status: 'UNKNOWN', checkedAt: null, error: null })

export const initialState = (): RuntimeState => ({
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
  error: null,
})

export const isReady = (state: RuntimeState): boolean =>
  state.status === 'READY' &&
  state.evidence !== null &&
  Object.values(state.health.dependencies).every((dependency) => dependency.status === 'AVAILABLE')
