import { Schema } from 'effect'

import {
  AccountStatus,
  AssetClass,
  AssetExchange,
  AssetStatus,
  type Account,
  type AccountConfigurationObservation,
  type AssetObservation,
  type AssetObservationExchange,
  type ReadResult,
} from '../broker/alpaca'
import { RuntimeProvenanceSchema } from '../contracts'
import type { AutonomousCycle } from '../cycle'
import type { CycleOperationsProjection } from '../cycle-observability'
import { Authority, OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import {
  GitSourceRevisionSchema,
  ImageDigestSchema,
  ImageRepositorySchema,
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnitIntervalSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
} from '../schemas'
import type { ObserveShadowDecisionDocument } from '../shadow-decision-contract'

export const discoverySchemaVersion = 'bayn.paper-candidate-discovery.v2' as const
export const bindingSchemaVersion = 'bayn.paper-candidate-discovery-binding.v1' as const
export const candidateFactsSchemaVersion = 'bayn.paper-candidate-facts.v1' as const
export const observationReceiptSchemaVersion = 'bayn.paper-candidate-observation-receipt.v1' as const
export const assetReadConcurrency = 3
const AssetObservationExchangeSchema = Schema.Enum(AssetExchange).pipe(
  Schema.refine((exchange): exchange is AssetObservationExchange => exchange !== AssetExchange.Empty, {
    expected: 'an Alpaca asset exchange other than the empty sentinel',
  }),
)

export const ReadEvidenceSchema = Schema.Struct({
  requestId: StrictNonEmptyStringSchema,
  status: NonNegativeIntegerSchema,
  contentHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  rateLimit: Schema.optionalKey(
    Schema.Struct({
      limit: Schema.optionalKey(Schema.String),
      remaining: Schema.optionalKey(Schema.String),
      reset: Schema.optionalKey(Schema.String),
      retryAfter: Schema.optionalKey(Schema.String),
    }),
  ),
})

export const AccountObservationSchema = Schema.Struct({
  id: StrictNonEmptyStringSchema,
  status: Schema.Enum(AccountStatus),
  currency: Schema.Literal('USD'),
  cashMicros: SignedMicrosSchema,
  equityMicros: SignedMicrosSchema,
  lastEquityMicros: SignedMicrosSchema,
  buyingPowerMicros: SignedMicrosSchema,
  accountBlocked: Schema.Boolean,
  tradingBlocked: Schema.Boolean,
  tradeSuspendedByUser: Schema.Boolean,
  observedAt: UtcInstantSchema,
})

export const AccountConfigurationObservationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-account-configuration-observation.v1'),
  source: Schema.Literal('alpaca-v2-account-configurations'),
  requestHash: Sha256Schema,
  fractionalTrading: Schema.Boolean,
  observedAt: UtcInstantSchema,
  normalizedResponseHash: Sha256Schema,
})

export const AssetObservationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-asset-observation.v1'),
  source: Schema.Literal('alpaca-v2-asset'),
  requestedSymbol: SymbolSchema,
  requestHash: Sha256Schema,
  assetId: StrictNonEmptyStringSchema,
  symbol: SymbolSchema,
  assetClass: Schema.Enum(AssetClass),
  exchange: AssetObservationExchangeSchema,
  status: Schema.Enum(AssetStatus),
  tradable: Schema.Boolean,
  fractionable: Schema.Boolean,
  attributes: Schema.Array(StrictNonEmptyStringSchema),
  observedAt: UtcInstantSchema,
  normalizedResponseHash: Sha256Schema,
})

export enum PaperCandidateIneligibility {
  AssetClass = 'ASSET_CLASS_NOT_US_EQUITY',
  Inactive = 'ASSET_INACTIVE',
  Ipo = 'ASSET_IPO',
  NotFractionable = 'ASSET_NOT_FRACTIONABLE',
  NotTradable = 'ASSET_NOT_TRADABLE',
  Otc = 'ASSET_OTC',
  PtpNoException = 'ASSET_PTP_NO_EXCEPTION',
}

export const CandidateIneligibilitySchema = Schema.Enum(PaperCandidateIneligibility)

export const RuntimeIdentitySchema = Schema.Struct({
  sourceRevision: GitSourceRevisionSchema,
  image: Schema.Struct({
    repository: ImageRepositorySchema,
    digest: ImageDigestSchema,
  }),
  strategy: RuntimeProvenanceSchema.fields.strategy,
  strategyProtocolHash: Sha256Schema,
  qualificationRunId: Sha256Schema,
  accountId: StrictNonEmptyStringSchema,
  authorityGenerationHash: Sha256Schema,
  policyHash: Sha256Schema,
})
export type ExecutionCandidateDiscoveryIdentity = typeof RuntimeIdentitySchema.Type

export const DiscoveryBindingSchema = Schema.Struct({
  schemaVersion: Schema.Literal(bindingSchemaVersion),
  runtime: RuntimeIdentitySchema,
  cycle: Schema.Struct({
    cycleId: Sha256Schema,
    signalSessionDate: IsoDateSchema,
    executionSessionDate: IsoDateSchema,
    snapshotId: Sha256Schema,
    decisionHash: Sha256Schema,
    submissionCutoffAt: UtcInstantSchema,
    terminalAt: UtcInstantSchema,
  }),
  document: Schema.Struct({
    contentHash: Sha256Schema,
    snapshotContentHash: Sha256Schema,
    snapshotFinalizedAt: UtcInstantSchema,
    strategyDecisionHash: Sha256Schema,
    policyHash: Sha256Schema,
    planningBrokerStateHash: Sha256Schema,
    reconciliationId: Sha256Schema,
    reconciliationHash: Sha256Schema,
    targetPlanInputHash: Sha256Schema,
    targetPlanOutputHash: Sha256Schema,
    createdAt: UtcInstantSchema,
    expiresAt: UtcInstantSchema,
  }),
})
export type ExecutionCandidateDiscoveryBinding = typeof DiscoveryBindingSchema.Type

export const AccountFactsSchema = Schema.Struct({
  id: StrictNonEmptyStringSchema,
  status: Schema.Enum(AccountStatus),
  currency: Schema.Literal('USD'),
  cashMicros: SignedMicrosSchema,
  equityMicros: SignedMicrosSchema,
  buyingPowerMicros: SignedMicrosSchema,
  accountBlocked: Schema.Boolean,
  tradingBlocked: Schema.Boolean,
  tradeSuspendedByUser: Schema.Boolean,
})

export const AccountConfigurationFactsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-account-configuration-observation.v1'),
  source: Schema.Literal('alpaca-v2-account-configurations'),
  requestHash: Sha256Schema,
  fractionalTrading: Schema.Boolean,
  normalizedResponseHash: Sha256Schema,
})

export const AssetFactsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-asset-observation.v1'),
  source: Schema.Literal('alpaca-v2-asset'),
  requestedSymbol: SymbolSchema,
  requestHash: Sha256Schema,
  assetId: StrictNonEmptyStringSchema,
  symbol: SymbolSchema,
  assetClass: Schema.Enum(AssetClass),
  exchange: AssetObservationExchangeSchema,
  status: Schema.Enum(AssetStatus),
  tradable: Schema.Boolean,
  fractionable: Schema.Boolean,
  attributes: Schema.Array(StrictNonEmptyStringSchema),
  normalizedResponseHash: Sha256Schema,
})

export const CandidateFactsSchema = Schema.Struct({
  ordinal: NonNegativeIntegerSchema,
  observedPlanIntentId: Sha256Schema,
  symbol: SymbolSchema,
  side: Schema.Enum(OrderSide),
  orderType: Schema.Enum(OrderType),
  timeInForce: Schema.Enum(TimeInForce),
  observedPlannedQuantityMicros: PositiveMicrosSchema,
  observedReferencePriceMicros: PositiveMicrosSchema,
  observedNotionalLimitMicros: PositiveMicrosSchema,
  observedEvaluatedOrderNotionalMicros: UnsignedMicrosSchema,
  observedTargetWeight: UnitIntervalSchema,
  observedCurrentQuantityMicros: SignedMicrosSchema,
  observedTargetQuantityMicros: SignedMicrosSchema,
  observedRiskDecisionId: Sha256Schema,
  observedRiskInputHash: Sha256Schema,
  asset: AssetFactsSchema,
  assetEligibility: Schema.Struct({
    eligible: Schema.Boolean,
    reasons: Schema.Array(CandidateIneligibilitySchema),
  }),
  fractionalTradingEligible: Schema.Boolean,
})

export const CandidateFactsMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(candidateFactsSchemaVersion),
  immutableBindingHash: Sha256Schema,
  account: AccountFactsSchema,
  accountConfiguration: AccountConfigurationFactsSchema,
  candidates: Schema.Array(CandidateFactsSchema),
  consistencyDelayMs: Schema.Struct({
    status: Schema.Literal('REQUIRED_UNBOUND'),
  }),
})
export type PaperCandidateFactsMaterial = typeof CandidateFactsMaterialSchema.Type

export const BrokerObservationsSchema = Schema.Struct({
  account: Schema.Struct({
    value: AccountObservationSchema,
    evidence: ReadEvidenceSchema,
  }),
  accountConfiguration: Schema.Struct({
    value: AccountConfigurationObservationSchema,
    evidence: ReadEvidenceSchema,
  }),
  assets: Schema.Array(
    Schema.Struct({
      ordinal: NonNegativeIntegerSchema,
      value: AssetObservationSchema,
      evidence: ReadEvidenceSchema,
    }),
  ),
})

export const DiscoveryReceiptMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal(discoverySchemaVersion),
  operation: Schema.Literal('PAPER_CANDIDATE_DISCOVERY'),
  authority: Schema.Literal(Authority.Observe),
  dispatchable: Schema.Literal(false),
  binding: DiscoveryBindingSchema,
  immutableBindingHash: Sha256Schema,
  candidateFacts: CandidateFactsMaterialSchema,
  candidateFactsHash: Sha256Schema,
  observations: BrokerObservationsSchema,
  capturedAt: UtcInstantSchema,
  observationReceiptSchemaVersion: Schema.Literal(observationReceiptSchemaVersion),
})

export const DiscoveryReceiptSchema = Schema.Struct({
  ...DiscoveryReceiptMaterialSchema.fields,
  observationReceiptHash: Sha256Schema,
})
export type ExecutionCandidateDiscoveryReceipt = typeof DiscoveryReceiptSchema.Type

export type ExecutionCandidateDiscoverySnapshot = {
  readonly projection: CycleOperationsProjection
  readonly cycle: AutonomousCycle
  readonly document: ObserveShadowDecisionDocument
}

export const ValidatedSnapshotTypeId: unique symbol = Symbol('bayn/ValidatedPaperCandidateSnapshot')
export type ValidatedPaperCandidateSnapshot = {
  readonly [ValidatedSnapshotTypeId]: true
  readonly identity: ExecutionCandidateDiscoveryIdentity
  readonly snapshot: ExecutionCandidateDiscoverySnapshot
  readonly binding: ExecutionCandidateDiscoveryBinding
}

export const ValidatedAccountTypeId: unique symbol = Symbol('bayn/ValidatedPaperCandidateAccount')
export type ValidatedAccount = {
  readonly [ValidatedAccountTypeId]: true
  readonly read: ReadResult<Account>
}

export const ValidatedAccountConfigurationTypeId: unique symbol = Symbol(
  'bayn/ValidatedPaperCandidateAccountConfiguration',
)
export type ValidatedAccountConfiguration = {
  readonly [ValidatedAccountConfigurationTypeId]: true
  readonly read: ReadResult<AccountConfigurationObservation>
}

export const ValidatedAssetsTypeId: unique symbol = Symbol('bayn/ValidatedPaperCandidateAssets')
export type ValidatedAssets = {
  readonly [ValidatedAssetsTypeId]: true
  readonly reads: ReadonlyArray<ReadResult<AssetObservation>>
}

export const ValidatedObservationsTypeId: unique symbol = Symbol('bayn/ValidatedPaperCandidateObservations')
export type ValidatedPaperCandidateObservations = {
  readonly [ValidatedObservationsTypeId]: true
  readonly account: ValidatedAccount
  readonly accountConfiguration: ValidatedAccountConfiguration
  readonly assets: ValidatedAssets
  readonly capturedAt: string
}
