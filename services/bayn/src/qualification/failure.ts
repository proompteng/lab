import type { Schema } from 'effect'

import { renderCanonicalJsonFailure, type CanonicalJsonFailure } from '../hash'

export type QualificationConstructionFailure =
  | {
      readonly _tag: 'QualificationCanonicalizationFailed'
      readonly operation: 'lock-material' | 'policy-content' | 'result-material'
      readonly cause: CanonicalJsonFailure
    }
  | {
      readonly _tag: 'QualificationSchemaInvalid'
      readonly operation: 'lock' | 'lock-material' | 'policy-document' | 'result'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'QualificationRunIdMismatch'
      readonly lockRunId: string
      readonly analysisRunId: string
    }
  | {
      readonly _tag: 'QualificationPriorTrialLineageMismatch'
      readonly lockedRunIds: readonly string[]
      readonly analyzedRunIds: readonly string[]
    }

export const renderQualificationConstructionFailure = (failure: QualificationConstructionFailure): string => {
  switch (failure._tag) {
    case 'QualificationCanonicalizationFailed':
      return `${failure.operation} canonicalization failed: ${renderCanonicalJsonFailure(failure.cause)}`
    case 'QualificationSchemaInvalid':
      return `${failure.operation} schema validation failed: ${failure.cause.message}`
    case 'QualificationRunIdMismatch':
      return `qualification analysis run ${failure.analysisRunId} does not match locked run ${failure.lockRunId}`
    case 'QualificationPriorTrialLineageMismatch':
      return `qualification analysis lineage ${failure.analyzedRunIds.join(',')} does not match locked lineage ${failure.lockedRunIds.join(',')}`
  }
}
