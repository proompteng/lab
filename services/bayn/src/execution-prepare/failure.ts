import type { Schema } from 'effect'

import type { ExecutionStoreError } from '../db/execution-store'
import type { CanonicalJsonFailure } from '../hash'

export type ExecutionPrepareRuntimeField =
  | 'request'
  | 'brokerIdentity'
  | 'brokerProvider'
  | 'brokerEnvironment'
  | 'brokerAccess'
  | 'capitalAuthority'
  | 'qualificationRunId'
  | 'activationSourceRevision'
  | 'activationImageRepository'
  | 'activationImageDigest'
  | 'strategyName'
  | 'strategyBehaviorHash'
  | 'strategyParameterHash'
  | 'strategyParameterSchemaVersion'
  | 'strategyProtocolHash'
  | 'accountId'
  | 'authorityGenerationHash'
  | 'riskPolicyHash'

export type ExecutionPrepareGenerationField =
  | 'maximum'
  | 'previousGenerationHash'
  | 'qualificationRunId'
  | 'qualificationLockId'
  | 'qualificationResultHash'
  | 'protocolHash'
  | 'qualificationExecutionPolicyHash'
  | 'qualificationSourceRevision'
  | 'qualificationImageRepository'
  | 'qualificationImageDigest'
  | 'activationSourceRevision'
  | 'activationImageRepository'
  | 'activationImageDigest'
  | 'strategyName'
  | 'strategyBehaviorHash'
  | 'strategyParameterHash'
  | 'strategyParameterSchemaVersion'
  | 'accountId'
  | 'riskPolicyHash'
  | 'proofPlanHash'
  | 'reconciliationId'
  | 'reconciliationContentHash'

export type ExecutionPrepareDiscoveryField =
  | 'observationReceiptHash'
  | 'immutableBindingHash'
  | 'candidateFactsHash'
  | 'candidateOrdinal'
  | 'observedPlanIntentId'
  | 'cycleId'
  | 'decisionHash'
  | 'sourceRevision'
  | 'imageRepository'
  | 'imageDigest'
  | 'strategyName'
  | 'strategyBehaviorHash'
  | 'strategyParameterHash'
  | 'strategyParameterSchemaVersion'
  | 'strategyProtocolHash'
  | 'qualificationRunId'
  | 'accountId'
  | 'authorityGenerationHash'
  | 'riskPolicyHash'
  | 'reconciliationId'
  | 'reconciliationContentHash'
  | 'assetEligibility'
  | 'fractionalTradingEligibility'

export type ExecutionPrepareFailure =
  | { readonly _tag: 'ExecutionPrepareRequestInvalid'; readonly cause: Schema.SchemaError }
  | { readonly _tag: 'ExecutionPrepareRuntimeBindingInvalid'; readonly cause: Schema.SchemaError }
  | { readonly _tag: 'ExecutionPrepareRuntimeMismatch'; readonly field: ExecutionPrepareRuntimeField }
  | { readonly _tag: 'ExecutionPrepareProofPlanHashFailed'; readonly cause: CanonicalJsonFailure }
  | { readonly _tag: 'ExecutionPrepareProofPlanHashMismatch' }
  | { readonly _tag: 'ExecutionPrepareDiscoveryHashFailed'; readonly cause: CanonicalJsonFailure }
  | { readonly _tag: 'ExecutionPrepareDiscoveryMismatch'; readonly field: ExecutionPrepareDiscoveryField }
  | {
      readonly _tag: 'ExecutionPrepareStoreRejected'
      readonly operation: ExecutionStoreError['operation']
      readonly failure: ExecutionStoreError['failure']
      readonly cause: ExecutionStoreError
    }
  | { readonly _tag: 'ExecutionPrepareGenerationMismatch'; readonly field: ExecutionPrepareGenerationField }
  | { readonly _tag: 'ExecutionPrepareReceiptHashFailed'; readonly cause: CanonicalJsonFailure }
  | { readonly _tag: 'ExecutionPrepareReceiptInvalid'; readonly cause: Schema.SchemaError }

export const renderExecutionPrepareFailure = (failure: ExecutionPrepareFailure): string => {
  switch (failure._tag) {
    case 'ExecutionPrepareRequestInvalid':
      return 'EXECUTION_PREPARE input is malformed'
    case 'ExecutionPrepareRuntimeBindingInvalid':
      return 'EXECUTION_PREPARE runtime binding is malformed'
    case 'ExecutionPrepareRuntimeMismatch':
      return `EXECUTION_PREPARE runtime binding drifted at ${failure.field}`
    case 'ExecutionPrepareProofPlanHashFailed':
      return 'EXECUTION_PREPARE proof plan could not be content-hashed'
    case 'ExecutionPrepareProofPlanHashMismatch':
      return 'EXECUTION_PREPARE proof plan hash does not match its explicit material'
    case 'ExecutionPrepareDiscoveryHashFailed':
      return 'EXECUTION_PREPARE discovery evidence could not be content-hashed'
    case 'ExecutionPrepareDiscoveryMismatch':
      return `EXECUTION_PREPARE discovery evidence drifted at ${failure.field}`
    case 'ExecutionPrepareStoreRejected':
      return `EXECUTION_PREPARE durable validation failed closed (${failure.operation}/${failure.failure})`
    case 'ExecutionPrepareGenerationMismatch':
      return `EXECUTION_PREPARE durable generation drifted at ${failure.field}`
    case 'ExecutionPrepareReceiptHashFailed':
      return 'EXECUTION_PREPARE receipt could not be content-hashed'
    case 'ExecutionPrepareReceiptInvalid':
      return 'EXECUTION_PREPARE receipt violates its redacted contract'
  }
}
