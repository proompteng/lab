import { Data, Effect, Schema } from 'effect'

import { BrokerProvider } from '../broker/connection'
import { BrokerEnvironment } from '../broker/identity'
import { BrokerAccess, CapitalAuthorityKind, type ExecutionStrategyIdentity } from '../execution/authority'
import {
  IntentState,
  type CapitalGrantGeneration,
  type CapitalGrantProofBinding,
  type TerminalOutcome,
} from '../execution/contracts'
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
import { Pipeable } from '../pipeable'

export const paperProofCommandSchemaVersion = 'bayn.paper-proof-command.v1' as const
export const paperProofReceiptSchemaVersion = 'bayn.paper-proof-receipt.v1' as const
export const paperProofRecoveryRequiredSchemaVersion = 'bayn.paper-proof-recovery-required.v1' as const
export const paperProofRecoveryCompletionSchemaVersion = 'bayn.paper-proof-recovery-completion.v1' as const

export const PaperProofOperationSchema = Schema.Literals(['PREPARE', 'SUBMIT', 'CANCEL', 'RECOVER'])
export type PaperProofOperation = typeof PaperProofOperationSchema.Type
export type PaperProofMutationOperation = Extract<PaperProofOperation, 'SUBMIT' | 'CANCEL'>

export const PaperProofCommandSchema = Schema.Struct({
  schemaVersion: Schema.Literal(paperProofCommandSchemaVersion),
  operation: PaperProofOperationSchema,
  timeoutMs: PositiveIntegerSchema,
  containmentIoTimeoutMs: PositiveIntegerSchema,
  consistencyDelayMs: PositiveIntegerSchema,
  proofPlanHash: Sha256Schema,
  riskPolicyHash: Sha256Schema,
  qualificationRunId: Sha256Schema,
  sourceRevision: GitSourceRevisionSchema,
  imageRepository: ImageRepositorySchema,
  imageDigest: ImageDigestSchema,
})
export type PaperProofCommand = typeof PaperProofCommandSchema.Type

const decodePaperProofCommandResultDataFirst = Schema.decodeUnknownResult(PaperProofCommandSchema, strictParseOptions)

export const decodePaperProofCommandResult = Pipeable.dual(1, (input: unknown) =>
  decodePaperProofCommandResultDataFirst(input),
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

export interface PaperProofIntentSnapshot {
  readonly state: IntentState
  readonly terminalOutcome?: TerminalOutcome
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
  readonly recoveryRequired: boolean
  readonly completedAt: string
}

export interface PaperProofRecoveryRequired {
  readonly schemaVersion: typeof paperProofRecoveryRequiredSchemaVersion
  readonly intentId: string
  readonly proofPlanHash: string
  readonly qualificationRunId: string
  readonly operation: PaperProofMutationOperation
  readonly reason: string
  readonly requiredAt: string
}

export interface PaperProofRecoveryCompletion {
  readonly schemaVersion: typeof paperProofRecoveryCompletionSchemaVersion
  readonly intentId: string
  readonly proofPlanHash: string
  readonly qualificationRunId: string
  readonly operation: PaperProofMutationOperation
  readonly clientOrderId?: string
  readonly mutation: MutationEvent
  readonly reconciliations: readonly PaperProofReconciliation[]
  readonly restricted: boolean
  readonly completedAt: string
}

export interface PaperProofRecoveryCompletionGuard {
  readonly expectedLatestMutation: MutationEvent
  readonly rejectAnyCancellation: boolean
}

/**
 * This store is part of the safety boundary. Implementations must durably commit an idempotent recovery-required
 * marker before resolving `markRequired`. A newly committed marker must atomically supersede any older completion for
 * the same intent. `complete` must atomically verify `guard.expectedLatestMutation` is still the latest event for the
 * completed operation, enforce `guard.rejectAnyCancellation`, persist completion evidence, and retire the exact
 * matching marker when one exists. It must refuse to let older SUBMIT evidence replace a newer durable cancellation
 * mutation or completion and support markerless reconstruction when the caller binds the completion to the current
 * latest durable mutation. A retry after an ambiguous `complete` result must be able to read the committed completion
 * through `loadCompletion`. Loaded completion is advisory until the caller revalidates it against current durable
 * mutation and authority truth.
 */
export interface PaperProofRecoveryStore {
  readonly load: (intentId: string) => Effect.Effect<PaperProofRecoveryRequired | undefined, Error>
  readonly loadCompletion: (intentId: string) => Effect.Effect<PaperProofRecoveryCompletion | undefined, Error>
  readonly markRequired: (required: PaperProofRecoveryRequired) => Effect.Effect<void, Error>
  readonly complete: (
    completion: PaperProofRecoveryCompletion,
    guard: PaperProofRecoveryCompletionGuard,
  ) => Effect.Effect<void, Error>
}

export class PaperProofError extends Data.TaggedError('PaperProofError')<{
  readonly operation: PaperProofOperation | 'GATE' | 'RECONCILE' | 'RECOVERY_STATE' | 'RESTRICT' | 'TIMEOUT'
  readonly failure: 'contract' | 'gate-closed' | 'invariant' | 'mutation-unresolved' | 'operational' | 'timeout'
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
const decodePaperProofCliEnvelopeResultDataFirst = Schema.decodeUnknownResult(
  PaperProofCliEnvelopeSchema,
  strictParseOptions,
)

export const decodePaperProofCliEnvelopeResult = Pipeable.dual(1, (input: unknown) =>
  decodePaperProofCliEnvelopeResultDataFirst(input),
)
