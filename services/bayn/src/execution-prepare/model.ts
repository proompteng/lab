import { Result, Schema } from 'effect'

import { BrokerEnvironment, BrokerProvider } from '../broker/identity'
import type { ReadPreflight } from '../broker/alpaca'
import { RuntimeProvenanceSchema } from '../contracts'
import { DiscoveryReceiptSchema } from '../execution-candidate-discovery/model'
import { BrokerAccess, CapitalAuthorityKind } from '../execution/authority'
import { Authority, type CapitalGrantGeneration } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import {
  GitSourceRevisionSchema,
  ImageDigestSchema,
  ImageRepositorySchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  strictParseOptions,
} from '../schemas'

export const executionPrepareRequestSchemaVersion = 'bayn.execution-prepare-request.v1' as const
export const executionPrepareProofPlanSchemaVersion = 'bayn.execution-prepare-proof-plan.v1' as const
export const executionPrepareReceiptSchemaVersion = 'bayn.execution-prepare-receipt.v1' as const

const StrategySchema = RuntimeProvenanceSchema.fields.strategy.pipe(
  Schema.refine(
    (
      strategy,
    ): strategy is typeof RuntimeProvenanceSchema.fields.strategy.Type & {
      readonly name: 'risk-balanced-trend'
      readonly parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4'
    } =>
      strategy.name === 'risk-balanced-trend' &&
      strategy.parameterSchemaVersion === 'bayn.risk-balanced-trend.protocol.v4',
    { expected: 'the current risk-balanced-trend protocol v4 strategy identity' },
  ),
)

export const ExecutionPrepareProofPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal(executionPrepareProofPlanSchemaVersion),
  candidateSet: Schema.Struct({
    discoveryReceiptHash: Sha256Schema,
    immutableBindingHash: Sha256Schema,
    candidateFactsHash: Sha256Schema,
    candidateCount: PositiveIntegerSchema,
    cycleId: Sha256Schema,
    decisionHash: Sha256Schema,
  }),
  binding: Schema.Struct({
    activationSourceRevision: GitSourceRevisionSchema,
    activationImageRepository: ImageRepositorySchema,
    activationImageDigest: ImageDigestSchema,
    qualificationSourceRevision: GitSourceRevisionSchema,
    qualificationImageRepository: ImageRepositorySchema,
    qualificationImageDigest: ImageDigestSchema,
    strategy: StrategySchema,
    strategyProtocolHash: Sha256Schema,
    qualificationRunId: Sha256Schema,
    qualificationLockId: Sha256Schema,
    qualificationResultHash: Sha256Schema,
    protocolHash: Sha256Schema,
    qualificationExecutionPolicyHash: Sha256Schema,
    accountId: StrictNonEmptyStringSchema,
    brokerIdentityHash: Sha256Schema,
    authorityGenerationHash: Sha256Schema,
    riskPolicyHash: Sha256Schema,
    reconciliationId: Sha256Schema,
    reconciliationContentHash: Sha256Schema,
  }),
})
export type ExecutionPrepareProofPlan = typeof ExecutionPrepareProofPlanSchema.Type

export const ExecutionPrepareRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(executionPrepareRequestSchemaVersion),
  qualification: Schema.Struct({
    runId: Sha256Schema,
    lockId: Sha256Schema,
    resultHash: Sha256Schema,
    verdict: Schema.Literal('QUALIFIED'),
    sourceRevision: GitSourceRevisionSchema,
    imageRepository: ImageRepositorySchema,
    imageDigest: ImageDigestSchema,
    candidateOrdinal: NonNegativeIntegerSchema,
  }),
  discoveryReceipt: DiscoveryReceiptSchema,
})
export type ExecutionPrepareRequest = typeof ExecutionPrepareRequestSchema.Type

export const decodeExecutionPrepareRequestResult = Schema.decodeUnknownResult(
  ExecutionPrepareRequestSchema,
  strictParseOptions,
)

export const ExecutionPrepareProofPlanRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(executionPrepareRequestSchemaVersion),
  discoveryReceipt: DiscoveryReceiptSchema,
  proofPlan: ExecutionPrepareProofPlanSchema,
  proofPlanHash: Sha256Schema,
})
export type ExecutionPrepareProofPlanRequest = typeof ExecutionPrepareProofPlanRequestSchema.Type

export const decodeExecutionPrepareProofPlanRequestResult = Schema.decodeUnknownResult(
  ExecutionPrepareProofPlanRequestSchema,
  strictParseOptions,
)

export const ExecutionPrepareRuntimeBindingSchema = Schema.Struct({
  sourceRevision: GitSourceRevisionSchema,
  imageRepository: ImageRepositorySchema,
  imageDigest: ImageDigestSchema,
  strategy: StrategySchema,
  strategyProtocolHash: Sha256Schema,
  qualificationRunId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  brokerIdentityHash: Sha256Schema,
  brokerProvider: Schema.Enum(BrokerProvider),
  brokerEnvironment: Schema.Enum(BrokerEnvironment),
  brokerAccess: Schema.Enum(BrokerAccess),
  capitalAuthority: Schema.Enum(CapitalAuthorityKind),
  authorityGenerationHash: Sha256Schema,
  riskPolicyHash: Sha256Schema,
})
export type ExecutionPrepareRuntimeBinding = typeof ExecutionPrepareRuntimeBindingSchema.Type

const ExecutionPrepareReceiptMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(executionPrepareReceiptSchemaVersion),
  operation: Schema.Literal('EXECUTION_PREPARE'),
  dispatchable: Schema.Literal(false),
  authority: Schema.Struct({
    maximum: Schema.Literal(Authority.Observe),
    effective: Schema.Literal(Authority.Observe),
    activated: Schema.Literal(false),
  }),
  broker: Schema.Struct({
    identityHash: Sha256Schema,
    provider: Schema.Literal(BrokerProvider.Alpaca),
    environment: Schema.Literal(BrokerEnvironment.Sandbox),
    access: Schema.Literal(BrokerAccess.ReadOnly),
  }),
  candidateSet: ExecutionPrepareProofPlanSchema.fields.candidateSet,
  qualification: Schema.Struct({
    runId: Sha256Schema,
    lockId: Sha256Schema,
    resultHash: Sha256Schema,
    protocolHash: Sha256Schema,
    executionPolicyHash: Sha256Schema,
  }),
  strategy: StrategySchema,
  generation: Schema.Struct({
    generationHash: Sha256Schema,
    previousGenerationHash: Sha256Schema,
    riskPolicyHash: Sha256Schema,
    proofPlanHash: Sha256Schema,
  }),
  reconciliation: Schema.Struct({
    reconciliationId: Sha256Schema,
    contentHash: Sha256Schema,
  }),
  dryRunSubmit: Schema.Struct({
    included: Schema.Literal(false),
    reason: Schema.Literal('MUTATION_AUTHORITY_REQUIRED'),
  }),
})

const ExecutionPrepareReceiptBase = Schema.Struct({
  ...ExecutionPrepareReceiptMaterialSchema.fields,
  receiptHash: Sha256Schema,
})

export const ExecutionPrepareReceiptSchema = ExecutionPrepareReceiptBase.check(
  Schema.makeFilter(
    (receipt: typeof ExecutionPrepareReceiptBase.Type) => {
      const { receiptHash, ...material } = receipt
      const expected = canonicalHashV1Result(material)
      return Result.isSuccess(expected) && receiptHash === expected.success
    },
    { expected: 'a receipt hash matching the redacted EXECUTION_PREPARE material' },
  ),
)
export type ExecutionPrepareReceipt = typeof ExecutionPrepareReceiptSchema.Type

export const decodeExecutionPrepareReceiptResult = Schema.decodeUnknownResult(
  ExecutionPrepareReceiptSchema,
  strictParseOptions,
)

export interface ExecutionPrepareOutput {
  readonly receipt: ExecutionPrepareReceipt
  readonly generation: CapitalGrantGeneration
  readonly preflight: ReadPreflight
}
