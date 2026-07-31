import { Data, Schema } from 'effect'

import { BrokerProvider } from '../broker/connection'
import { BrokerEnvironment } from '../broker/identity'
import { BrokerAccess, CapitalAuthorityKind, type ExecutionStrategyIdentity } from '../execution/authority'
import type { CapitalGrantGeneration, CapitalGrantProofBinding } from '../execution/contracts'
import type { MutationEvent } from '../execution/mutations'
import {
  GitSourceRevisionSchema,
  ImageDigestSchema,
  ImageRepositorySchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  strictParseOptions,
} from '../schemas'

export const paperProofCommandSchemaVersion = 'bayn.paper-proof-command.v1' as const
export const paperProofReceiptSchemaVersion = 'bayn.paper-proof-receipt.v1' as const

export const PaperProofOperationSchema = Schema.Literals(['PREPARE', 'SUBMIT', 'CANCEL', 'RECOVER'])
export type PaperProofOperation = typeof PaperProofOperationSchema.Type

export const PaperProofCommandSchema = Schema.Struct({
  schemaVersion: Schema.Literal(paperProofCommandSchemaVersion),
  operation: PaperProofOperationSchema,
  timeoutMs: PositiveIntegerSchema,
  consistencyDelayMs: PositiveIntegerSchema,
  proofPlanHash: Sha256Schema,
  riskPolicyHash: Sha256Schema,
  qualificationRunId: Sha256Schema,
  sourceRevision: GitSourceRevisionSchema,
  imageRepository: ImageRepositorySchema,
  imageDigest: ImageDigestSchema,
})
export type PaperProofCommand = typeof PaperProofCommandSchema.Type

export const decodePaperProofCommandResult = Schema.decodeUnknownResult(
  PaperProofCommandSchema,
  strictParseOptions,
)

export interface PaperProofSourcePlan {
  readonly schemaVersion: 'bayn.paper-proof-plan.v1'
  readonly proofPlanHash: string
  readonly riskPolicyHash: string
  readonly qualificationRunId: string
  readonly qualificationResult: 'QUALIFIED'
  readonly qualificationPinned: true
  readonly sourceRevision: string
  readonly imageRepository: string
  readonly imageDigest: string
  readonly brokerProvider: BrokerProvider.Alpaca
  readonly brokerEnvironment: BrokerEnvironment.Sandbox
  readonly accountId: string
  readonly authorityGenerationHash: string
  readonly strategy: ExecutionStrategyIdentity
  readonly intentId: string
}

export interface PaperProofRuntimeBinding {
  readonly sourceRevision: string
  readonly imageRepository: string
  readonly imageDigest: string
  readonly brokerProvider: BrokerProvider
  readonly brokerEnvironment: BrokerEnvironment
  readonly accountId: string
  readonly authorityGenerationHash: string
  readonly brokerAccess: BrokerAccess
  readonly capitalAuthority: CapitalAuthorityKind
  readonly strategy: ExecutionStrategyIdentity
}

export interface PaperProofReconciliation {
  readonly reconciliationId: string
  readonly contentHash: string
  readonly accountId: string
  readonly status: 'EXACT' | 'DISCREPANCY'
  readonly unknownMutationCount: number
  readonly reconciledAt: string
}

export interface PreparedPaperProofIntent {
  readonly intentId: string
  readonly clientOrderId: string
  readonly deduplicated: boolean
}

export interface PaperProofReceipt {
  readonly schemaVersion: typeof paperProofReceiptSchemaVersion
  readonly operation: PaperProofOperation
  readonly proofPlanHash: string
  readonly qualificationRunId: string
  readonly intentId: string
  readonly clientOrderId?: string
  readonly generation?: CapitalGrantGeneration
  readonly mutation?: MutationEvent
  readonly reconciliations: readonly PaperProofReconciliation[]
  readonly restricted: boolean
  readonly completedAt: string
}

export class PaperProofError extends Data.TaggedError('PaperProofError')<{
  readonly operation: PaperProofOperation | 'GATE' | 'RECONCILE' | 'RESTRICT' | 'TIMEOUT'
  readonly failure:
    | 'contract'
    | 'gate-closed'
    | 'invariant'
    | 'mutation-unresolved'
    | 'operational'
    | 'timeout'
  readonly message: string
  readonly cause?: unknown
}> {}

export const proofBinding = (command: PaperProofCommand): CapitalGrantProofBinding => ({
  schemaVersion: 'bayn.paper-authority-proof-binding.v1',
  proofPlanHash: command.proofPlanHash,
  riskPolicyHash: command.riskPolicyHash,
})

export const protectedEntryToken = (plan: PaperProofSourcePlan): string =>
  [plan.proofPlanHash, plan.qualificationRunId, plan.authorityGenerationHash, plan.intentId].join(':')

export const PaperProofCliEnvelopeSchema = Schema.Struct({
  command: PaperProofCommandSchema,
  protectedEntryToken: StrictNonEmptyStringSchema,
})
export type PaperProofCliEnvelope = typeof PaperProofCliEnvelopeSchema.Type
export const decodePaperProofCliEnvelopeResult = Schema.decodeUnknownResult(
  PaperProofCliEnvelopeSchema,
  strictParseOptions,
)
