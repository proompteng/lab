import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Option, Result, Schema, pipe } from 'effect'

import {
  AccountStatus,
  AssetClass,
  AssetExchange,
  AssetStatus,
  BrokerRead,
  type Account,
  type AccountConfigurationObservation,
  type AssetObservation,
  type AssetObservationExchange,
  type ReadEvidence,
  type ReadResult,
} from './broker/alpaca'
import { RuntimeProvenanceSchema, makeStrategyProtocolHash } from './contracts'
import { CycleState, type AutonomousCycle } from './cycle'
import type { CycleOperationsProjection } from './cycle-observability'
import { CycleObservability, type CycleObservabilityError } from './db/cycle-observability'
import { CycleStore, type CycleStoreError } from './db/cycle-store'
import { canonicalHashV1 } from './hash'
import { Authority, OrderSide, OrderType, RiskOutcome, TimeInForce } from './paper'
import { Gate, Reason } from './risk'
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
  strictParseOptions,
} from './schemas'
import type { ObserveShadowDecisionDocument } from './shadow-decision-contract'
import { TargetPlanStatus } from './target-planner'

const discoverySchemaVersion = 'bayn.paper-candidate-discovery.v2' as const
const bindingSchemaVersion = 'bayn.paper-candidate-discovery-binding.v1' as const
const candidateFactsSchemaVersion = 'bayn.paper-candidate-facts.v1' as const
const observationReceiptSchemaVersion = 'bayn.paper-candidate-observation-receipt.v1' as const
const assetReadConcurrency = 3
const AssetObservationExchangeSchema = Schema.Enum(AssetExchange).pipe(
  Schema.refine((exchange): exchange is AssetObservationExchange => exchange !== AssetExchange.Empty, {
    expected: 'an Alpaca asset exchange other than the empty sentinel',
  }),
)

const ReadEvidenceSchema = Schema.Struct({
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

const AccountObservationSchema = Schema.Struct({
  id: StrictNonEmptyStringSchema,
  status: Schema.Enum(AccountStatus),
  currency: Schema.Literal('USD'),
  cashMicros: SignedMicrosSchema,
  equityMicros: SignedMicrosSchema,
  buyingPowerMicros: SignedMicrosSchema,
  accountBlocked: Schema.Boolean,
  tradingBlocked: Schema.Boolean,
  tradeSuspendedByUser: Schema.Boolean,
  observedAt: UtcInstantSchema,
})

const AccountConfigurationObservationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-account-configuration-observation.v1'),
  source: Schema.Literal('alpaca-v2-account-configurations'),
  requestHash: Sha256Schema,
  fractionalTrading: Schema.Boolean,
  observedAt: UtcInstantSchema,
  normalizedResponseHash: Sha256Schema,
})

const AssetObservationSchema = Schema.Struct({
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

const CandidateIneligibilitySchema = Schema.Enum(PaperCandidateIneligibility)

const RuntimeIdentitySchema = Schema.Struct({
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
export type PaperCandidateDiscoveryIdentity = typeof RuntimeIdentitySchema.Type

const DiscoveryBindingSchema = Schema.Struct({
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
export type PaperCandidateDiscoveryBinding = typeof DiscoveryBindingSchema.Type

const AccountFactsSchema = Schema.Struct({
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

const AccountConfigurationFactsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.alpaca-account-configuration-observation.v1'),
  source: Schema.Literal('alpaca-v2-account-configurations'),
  requestHash: Sha256Schema,
  fractionalTrading: Schema.Boolean,
  normalizedResponseHash: Sha256Schema,
})

const AssetFactsSchema = Schema.Struct({
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

const CandidateFactsSchema = Schema.Struct({
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

const CandidateFactsMaterialSchema = Schema.Struct({
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

const BrokerObservationsSchema = Schema.Struct({
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

const DiscoveryReceiptMaterialSchema = Schema.Struct({
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

const DiscoveryReceiptSchema = Schema.Struct({
  ...DiscoveryReceiptMaterialSchema.fields,
  observationReceiptHash: Sha256Schema,
})
export type PaperCandidateDiscoveryReceipt = typeof DiscoveryReceiptSchema.Type

export type PaperCandidateDiscoveryError =
  | { readonly _tag: 'IdentityDecodeFailed'; readonly failure: 'invalid-input'; readonly cause: unknown }
  | {
      readonly _tag: 'StrategyProtocolMismatch'
      readonly failure: 'invalid-input'
      readonly observedStrategyProtocolHash: string
      readonly expectedStrategyProtocolHash: string
    }
  | {
      readonly _tag: 'CycleUnfinished'
      readonly failure: 'cycle-unfinished'
      readonly unfinishedCycleCount: number
      readonly currentCycleId: string | null
    }
  | {
      readonly _tag: 'CycleMissing'
      readonly failure: 'cycle-missing'
      readonly source: 'projection'
      readonly cycleId: null
    }
  | {
      readonly _tag: 'CycleMissing'
      readonly failure: 'cycle-missing'
      readonly source: 'cycle-store'
      readonly cycleId: string
    }
  | { readonly _tag: 'DocumentMissing'; readonly failure: 'document-missing'; readonly cycleId: string }
  | {
      readonly _tag: 'SnapshotTransactionFailed'
      readonly failure: 'transaction'
      readonly accountId: string
      readonly qualificationRunId: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CycleStateMismatch'
      readonly failure: 'cycle-mismatch'
      readonly source: 'projection' | 'cycle-store'
      readonly observedState: string
    }
  | {
      readonly _tag: 'CycleTerminalAtMissing'
      readonly failure: 'cycle-mismatch'
      readonly cycleId: string
    }
  | {
      readonly _tag: 'CycleIdentityMismatch'
      readonly failure: 'cycle-mismatch'
      readonly expectedCycleId: string
      readonly observedCycleId: string
    }
  | {
      readonly _tag: 'CycleAccountMismatch'
      readonly failure: 'cycle-mismatch'
      readonly expectedAccountId: string
      readonly projectedAccountId: string
      readonly storedAccountId: string
    }
  | {
      readonly _tag: 'CycleQualificationMismatch'
      readonly failure: 'cycle-mismatch'
      readonly expectedQualificationRunId: string
      readonly observedQualificationRunId: string
    }
  | {
      readonly _tag: 'CycleStrategyMismatch'
      readonly failure: 'cycle-mismatch'
      readonly expectedStrategyProtocolHash: string
      readonly observedStrategyProtocolHash: string
    }
  | {
      readonly _tag: 'CycleChronologyMismatch'
      readonly failure: 'cycle-mismatch'
      readonly cycleId: string
      readonly projected: {
        readonly signalSessionDate: string
        readonly executionSessionDate: string
        readonly submissionOpenAt: string
        readonly submissionCutoffAt: string
        readonly executionOpenAt: string
        readonly executionCloseAt: string
        readonly terminalAt: string | null
      }
      readonly stored: {
        readonly signalSessionDate: string
        readonly executionSessionDate: string
        readonly submissionOpenAt: string
        readonly submissionCutoffAt: string
        readonly executionOpenAt: string
        readonly executionCloseAt: string
        readonly terminalAt: string
      }
    }
  | {
      readonly _tag: 'CycleBindingMissing'
      readonly failure: 'document-mismatch'
      readonly binding: 'snapshot' | 'decision'
      readonly cycleId: string
    }
  | {
      readonly _tag: 'SnapshotBindingMismatch'
      readonly failure: 'document-mismatch'
      readonly storedSnapshotId: string
      readonly projectedSnapshotId: string | null
      readonly documentSnapshotId: string
    }
  | {
      readonly _tag: 'DecisionBindingMismatch'
      readonly failure: 'document-mismatch'
      readonly storedDecisionHash: string
      readonly projectedDecisionHash: string | null
      readonly documentContentHash: string
    }
  | {
      readonly _tag: 'DocumentIdentityMismatch'
      readonly failure: 'document-mismatch'
      readonly expected: {
        readonly cycleId: string
        readonly accountId: string
        readonly strategyName: string
        readonly strategyProtocolHash: string
      }
      readonly observed: {
        readonly cycleId: string
        readonly accountId: string
        readonly strategyName: string
        readonly strategyProtocolHash: string
      }
    }
  | {
      readonly _tag: 'DocumentPolicyMismatch'
      readonly failure: 'document-mismatch'
      readonly expectedPolicyHash: string
      readonly observedPolicyHash: string
    }
  | {
      readonly _tag: 'TargetPlanUnavailable'
      readonly failure: 'document-mismatch'
      readonly status: string
      readonly intentTargetCount: number
    }
  | {
      readonly _tag: 'RiskCountMismatch'
      readonly failure: 'risk-mismatch'
      readonly deltaRiskCount: number
      readonly intentTargetCount: number
    }
  | {
      readonly _tag: 'DocumentCutoffMismatch'
      readonly failure: 'document-mismatch'
      readonly cycleSubmissionCutoffAt: string
      readonly documentSubmissionCutoffAt: string
      readonly documentExpiresAt: string
    }
  | {
      readonly _tag: 'DocumentStale'
      readonly failure: 'document-stale'
      readonly observedAtMs: number
      readonly expiresAt: string
    }
  | {
      readonly _tag: 'AuthorityMismatch'
      readonly failure: 'authority-mismatch'
      readonly expectedGenerationHash: string
      readonly observedGenerationHash: string | null
      readonly observedMaximum: Authority | null
      readonly observedEffective: Authority | null
    }
  | {
      readonly _tag: 'RiskAuthorityMismatch'
      readonly failure: 'risk-mismatch'
      readonly index: number
      readonly outcome: RiskOutcome
      readonly reasonCodes: ReadonlyArray<string>
      readonly failedGates: ReadonlyArray<{ readonly name: string; readonly reason: string }>
    }
  | {
      readonly _tag: 'ReconciliationMissing'
      readonly failure: 'document-mismatch'
      readonly accountId: string
    }
  | {
      readonly _tag: 'ReconciliationMismatch'
      readonly failure: 'document-mismatch'
      readonly expectedAccountId: string
      readonly observedAccountId: string
      readonly expectedReconciliationId: string
      readonly observedReconciliationId: string
      readonly status: string
      readonly discrepancyCount: number
      readonly coversLatestMutation: boolean
    }
  | {
      readonly _tag: 'UnresolvedMutations'
      readonly failure: 'document-mismatch'
      readonly reconciliationId: string
      readonly unresolvedMutationCount: number
    }
  | {
      readonly _tag: 'BrokerReadFailed'
      readonly failure: 'broker'
      readonly read: 'account' | 'account-configuration'
      readonly accountId: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'BrokerReadFailed'
      readonly failure: 'broker'
      readonly read: 'assets'
      readonly accountId: string
      readonly symbols: ReadonlyArray<string>
      readonly cause: unknown
    }
  | {
      readonly _tag: 'AccountMismatch'
      readonly failure: 'account-mismatch'
      readonly expectedAccountId: string
      readonly observedAccountId: string
    }
  | {
      readonly _tag: 'ObservationTimeMismatch'
      readonly failure: 'broker'
      readonly observation: 'account' | 'account-configuration'
      readonly symbol: null
      readonly valueObservedAt: string
      readonly evidenceObservedAt: string
    }
  | {
      readonly _tag: 'ObservationTimeMismatch'
      readonly failure: 'broker'
      readonly observation: 'asset'
      readonly symbol: string
      readonly valueObservedAt: string
      readonly evidenceObservedAt: string
    }
  | {
      readonly _tag: 'ObservationChronologyMismatch'
      readonly failure: 'broker'
      readonly earlier: 'account'
      readonly later: 'account-configuration'
      readonly symbol: null
      readonly earlierObservedAt: string
      readonly laterObservedAt: string
    }
  | {
      readonly _tag: 'ObservationChronologyMismatch'
      readonly failure: 'broker'
      readonly earlier: 'account-configuration'
      readonly later: 'asset'
      readonly symbol: string
      readonly earlierObservedAt: string
      readonly laterObservedAt: string
    }
  | {
      readonly _tag: 'AssetMissing'
      readonly failure: 'broker'
      readonly ordinal: number
      readonly symbol: string
    }
  | {
      readonly _tag: 'AssetSymbolMismatch'
      readonly failure: 'broker'
      readonly ordinal: number
      readonly plannedSymbol: string
      readonly requestedSymbol: string
      readonly observedSymbol: string
    }
  | {
      readonly _tag: 'AssetCountMismatch'
      readonly failure: 'broker'
      readonly expectedAssetCount: number
      readonly observedAssetCount: number
    }
  | {
      readonly _tag: 'CandidateMaterialMissing'
      readonly failure: 'document-mismatch'
      readonly material: 'intent' | 'target'
      readonly ordinal: number
      readonly symbol: string | null
    }
  | {
      readonly _tag: 'CandidateMaterialMissing'
      readonly failure: 'risk-mismatch'
      readonly material: 'risk'
      readonly ordinal: number
      readonly symbol: string
    }
  | {
      readonly _tag: 'BindingHashFailed'
      readonly failure: 'output'
      readonly cycleId: string
      readonly documentContentHash: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateFactsDecodeFailed'
      readonly failure: 'output'
      readonly immutableBindingHash: string
      readonly candidateCount: number
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateFactsHashFailed'
      readonly failure: 'output'
      readonly immutableBindingHash: string
      readonly candidateCount: number
      readonly cause: unknown
    }
  | {
      readonly _tag: 'ReceiptHashFailed'
      readonly failure: 'output'
      readonly schemaVersion: string
      readonly candidateFactsHash: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'ReceiptDecodeFailed'
      readonly failure: 'output'
      readonly schemaVersion: string
      readonly candidateFactsHash: string
      readonly cause: unknown
    }

export type PaperCandidateDiscoverySnapshot = {
  readonly projection: CycleOperationsProjection
  readonly cycle: AutonomousCycle
  readonly document: ObserveShadowDecisionDocument
}

const ValidatedSnapshotTypeId: unique symbol = Symbol('bayn/ValidatedPaperCandidateSnapshot')
type ValidatedPaperCandidateSnapshot = {
  readonly [ValidatedSnapshotTypeId]: true
  readonly identity: PaperCandidateDiscoveryIdentity
  readonly snapshot: PaperCandidateDiscoverySnapshot
  readonly binding: PaperCandidateDiscoveryBinding
}

const ValidatedAccountTypeId: unique symbol = Symbol('bayn/ValidatedPaperCandidateAccount')
type ValidatedAccount = {
  readonly [ValidatedAccountTypeId]: true
  readonly read: ReadResult<Account>
}

const ValidatedAccountConfigurationTypeId: unique symbol = Symbol('bayn/ValidatedPaperCandidateAccountConfiguration')
type ValidatedAccountConfiguration = {
  readonly [ValidatedAccountConfigurationTypeId]: true
  readonly read: ReadResult<AccountConfigurationObservation>
}

const ValidatedAssetsTypeId: unique symbol = Symbol('bayn/ValidatedPaperCandidateAssets')
type ValidatedAssets = {
  readonly [ValidatedAssetsTypeId]: true
  readonly reads: ReadonlyArray<ReadResult<AssetObservation>>
}

const ValidatedObservationsTypeId: unique symbol = Symbol('bayn/ValidatedPaperCandidateObservations')
type ValidatedPaperCandidateObservations = {
  readonly [ValidatedObservationsTypeId]: true
  readonly account: ValidatedAccount
  readonly accountConfiguration: ValidatedAccountConfiguration
  readonly assets: ValidatedAssets
  readonly capturedAt: string
}

const paperCandidateDiscoveryErrorTags: ReadonlySet<string> = new Set([
  'IdentityDecodeFailed',
  'StrategyProtocolMismatch',
  'CycleUnfinished',
  'CycleMissing',
  'DocumentMissing',
  'SnapshotTransactionFailed',
  'CycleStateMismatch',
  'CycleTerminalAtMissing',
  'CycleIdentityMismatch',
  'CycleAccountMismatch',
  'CycleQualificationMismatch',
  'CycleStrategyMismatch',
  'CycleChronologyMismatch',
  'CycleBindingMissing',
  'SnapshotBindingMismatch',
  'DecisionBindingMismatch',
  'DocumentIdentityMismatch',
  'DocumentPolicyMismatch',
  'TargetPlanUnavailable',
  'RiskCountMismatch',
  'DocumentCutoffMismatch',
  'DocumentStale',
  'AuthorityMismatch',
  'RiskAuthorityMismatch',
  'ReconciliationMissing',
  'ReconciliationMismatch',
  'UnresolvedMutations',
  'BrokerReadFailed',
  'AccountMismatch',
  'ObservationTimeMismatch',
  'ObservationChronologyMismatch',
  'AssetMissing',
  'AssetSymbolMismatch',
  'AssetCountMismatch',
  'CandidateMaterialMissing',
  'BindingHashFailed',
  'CandidateFactsDecodeFailed',
  'CandidateFactsHashFailed',
  'ReceiptHashFailed',
  'ReceiptDecodeFailed',
])

const isPaperCandidateDiscoveryError = (cause: unknown): cause is PaperCandidateDiscoveryError =>
  typeof cause === 'object' &&
  cause !== null &&
  '_tag' in cause &&
  typeof cause._tag === 'string' &&
  paperCandidateDiscoveryErrorTags.has(cause._tag)

export const renderPaperCandidateDiscoveryError = (error: PaperCandidateDiscoveryError): string => {
  switch (error._tag) {
    case 'IdentityDecodeFailed':
      return 'paper candidate identity decoding failed'
    case 'StrategyProtocolMismatch':
      return `paper candidate strategy protocol mismatch: expected=${error.expectedStrategyProtocolHash} observed=${error.observedStrategyProtocolHash}`
    case 'CycleUnfinished':
      return `paper candidate discovery requires zero unfinished cycles: count=${error.unfinishedCycleCount} current=${error.currentCycleId ?? 'none'}`
    case 'CycleMissing':
      return `paper candidate cycle is missing: source=${error.source} cycle=${error.cycleId ?? 'none'}`
    case 'DocumentMissing':
      return `paper candidate decision document is missing: cycle=${error.cycleId}`
    case 'SnapshotTransactionFailed':
      return `paper candidate read-only snapshot transaction failed: qualification=${error.qualificationRunId} account=${error.accountId}`
    case 'CycleStateMismatch':
      return `paper candidate cycle state mismatch: source=${error.source} observed=${error.observedState}`
    case 'CycleTerminalAtMissing':
      return `paper candidate completed cycle has no terminal timestamp: cycle=${error.cycleId}`
    case 'CycleIdentityMismatch':
      return `paper candidate cycle identity mismatch: expected=${error.expectedCycleId} observed=${error.observedCycleId}`
    case 'CycleAccountMismatch':
      return `paper candidate cycle account mismatch: expected=${error.expectedAccountId} projection=${error.projectedAccountId} stored=${error.storedAccountId}`
    case 'CycleQualificationMismatch':
      return `paper candidate cycle qualification mismatch: expected=${error.expectedQualificationRunId} observed=${error.observedQualificationRunId}`
    case 'CycleStrategyMismatch':
      return `paper candidate cycle strategy mismatch: expected=${error.expectedStrategyProtocolHash} observed=${error.observedStrategyProtocolHash}`
    case 'CycleChronologyMismatch':
      return `paper candidate cycle chronology mismatch: cycle=${error.cycleId} projection=${JSON.stringify(error.projected)} stored=${JSON.stringify(error.stored)}`
    case 'CycleBindingMissing':
      return `paper candidate cycle ${error.binding} binding is missing: cycle=${error.cycleId}`
    case 'SnapshotBindingMismatch':
      return `paper candidate snapshot binding mismatch: stored=${error.storedSnapshotId} projection=${error.projectedSnapshotId ?? 'none'} document=${error.documentSnapshotId}`
    case 'DecisionBindingMismatch':
      return `paper candidate decision binding mismatch: stored=${error.storedDecisionHash} projection=${error.projectedDecisionHash ?? 'none'} document=${error.documentContentHash}`
    case 'DocumentIdentityMismatch':
      return `paper candidate document identity mismatch: expected=${JSON.stringify(error.expected)} observed=${JSON.stringify(error.observed)}`
    case 'DocumentPolicyMismatch':
      return `paper candidate policy mismatch: expected=${error.expectedPolicyHash} observed=${error.observedPolicyHash}`
    case 'TargetPlanUnavailable':
      return `paper candidate target plan is unavailable: status=${error.status} intents=${error.intentTargetCount}`
    case 'RiskCountMismatch':
      return `paper candidate risk count mismatch: risks=${error.deltaRiskCount} intents=${error.intentTargetCount}`
    case 'DocumentCutoffMismatch':
      return `paper candidate cutoff mismatch: cycle=${error.cycleSubmissionCutoffAt} document=${error.documentSubmissionCutoffAt} expires=${error.documentExpiresAt}`
    case 'DocumentStale':
      return `paper candidate document is stale: observedMs=${error.observedAtMs} expires=${error.expiresAt}`
    case 'AuthorityMismatch':
      return `paper candidate authority mismatch: expectedGeneration=${error.expectedGenerationHash} observedGeneration=${error.observedGenerationHash ?? 'none'} maximum=${error.observedMaximum ?? 'none'} effective=${error.observedEffective ?? 'none'}`
    case 'RiskAuthorityMismatch':
      return `paper candidate risk ${error.index} is not blocked only by authority: outcome=${error.outcome} reasons=${error.reasonCodes.join(',')}`
    case 'ReconciliationMissing':
      return `paper candidate reconciliation is missing: account=${error.accountId}`
    case 'ReconciliationMismatch':
      return `paper candidate reconciliation mismatch: expectedAccount=${error.expectedAccountId} observedAccount=${error.observedAccountId} expectedId=${error.expectedReconciliationId} observedId=${error.observedReconciliationId}`
    case 'UnresolvedMutations':
      return `paper candidate unresolved mutations remain: reconciliation=${error.reconciliationId} count=${error.unresolvedMutationCount}`
    case 'BrokerReadFailed':
      return error.read === 'assets'
        ? `paper candidate broker assets read failed: account=${error.accountId} symbols=${error.symbols.join(',')}`
        : `paper candidate broker ${error.read} read failed: account=${error.accountId}`
    case 'AccountMismatch':
      return `paper candidate account mismatch: expected=${error.expectedAccountId} observed=${error.observedAccountId}`
    case 'ObservationTimeMismatch':
      return `paper candidate ${error.observation} evidence time mismatch: symbol=${error.symbol ?? 'none'} value=${error.valueObservedAt} evidence=${error.evidenceObservedAt}`
    case 'ObservationChronologyMismatch':
      return `paper candidate observation chronology mismatch: earlier=${error.earlier}:${error.earlierObservedAt} later=${error.later}:${error.laterObservedAt} symbol=${error.symbol ?? 'none'}`
    case 'AssetMissing':
      return `paper candidate asset observation is missing: ordinal=${error.ordinal} symbol=${error.symbol}`
    case 'AssetSymbolMismatch':
      return `paper candidate asset symbol mismatch: ordinal=${error.ordinal} planned=${error.plannedSymbol} requested=${error.requestedSymbol} observed=${error.observedSymbol}`
    case 'AssetCountMismatch':
      return `paper candidate asset count mismatch: expected=${error.expectedAssetCount} observed=${error.observedAssetCount}`
    case 'CandidateMaterialMissing':
      return `paper candidate ${error.material} is missing: ordinal=${error.ordinal} symbol=${error.symbol ?? 'none'}`
    case 'BindingHashFailed':
      return `paper candidate binding hash failed: cycle=${error.cycleId} document=${error.documentContentHash}`
    case 'CandidateFactsDecodeFailed':
      return `paper candidate facts decoding failed: binding=${error.immutableBindingHash} candidates=${error.candidateCount}`
    case 'CandidateFactsHashFailed':
      return `paper candidate facts hash failed: binding=${error.immutableBindingHash} candidates=${error.candidateCount}`
    case 'ReceiptHashFailed':
      return `paper candidate receipt hash failed: schema=${error.schemaVersion} facts=${error.candidateFactsHash}`
    case 'ReceiptDecodeFailed':
      return `paper candidate receipt decoding failed: schema=${error.schemaVersion} facts=${error.candidateFactsHash}`
  }
}

const requireCondition = (
  condition: boolean,
  error: PaperCandidateDiscoveryError,
): Result.Result<void, PaperCandidateDiscoveryError> => (condition ? Result.succeed(undefined) : Result.fail(error))

const requireValue = <A>(
  value: A | null | undefined,
  error: PaperCandidateDiscoveryError,
): Result.Result<A, PaperCandidateDiscoveryError> =>
  value === null || value === undefined ? Result.fail(error) : Result.succeed(value)

const canonicalHashResult = (
  value: unknown,
  onFailure: (cause: unknown) => PaperCandidateDiscoveryError,
): Result.Result<string, PaperCandidateDiscoveryError> =>
  pipe(
    Result.try({
      try: () => canonicalHashV1(value),
      catch: onFailure,
    }),
  )

const validateIdentity = (
  input: PaperCandidateDiscoveryIdentity,
): Result.Result<PaperCandidateDiscoveryIdentity, PaperCandidateDiscoveryError> =>
  pipe(
    Schema.decodeUnknownResult(RuntimeIdentitySchema, strictParseOptions)(input),
    Result.mapError(
      (cause): PaperCandidateDiscoveryError => ({ _tag: 'IdentityDecodeFailed', failure: 'invalid-input', cause }),
    ),
    Result.flatMap((identity) =>
      pipe(
        requireCondition(identity.strategyProtocolHash === makeStrategyProtocolHash(identity.strategy), {
          _tag: 'StrategyProtocolMismatch',
          failure: 'invalid-input',
          observedStrategyProtocolHash: identity.strategyProtocolHash,
          expectedStrategyProtocolHash: makeStrategyProtocolHash(identity.strategy),
        }),
        Result.map(() => identity),
      ),
    ),
  )

const selectCompletedCycle = (
  projection: CycleOperationsProjection,
): Result.Result<NonNullable<CycleOperationsProjection['last']>, PaperCandidateDiscoveryError> =>
  pipe(
    requireCondition(projection.unfinishedCycleCount === 0 && projection.current === null, {
      _tag: 'CycleUnfinished',
      failure: 'cycle-unfinished',
      unfinishedCycleCount: projection.unfinishedCycleCount,
      currentCycleId: projection.current?.cycleId ?? null,
    }),
    Result.flatMap(() =>
      requireValue(projection.last, {
        _tag: 'CycleMissing',
        failure: 'cycle-missing',
        source: 'projection',
        cycleId: null,
      }),
    ),
  )

const readCycle = (
  store: CycleStore['Service'],
  cycleId: string,
): Effect.Effect<AutonomousCycle, CycleStoreError | PaperCandidateDiscoveryError, never> =>
  pipe(
    store.read(cycleId),
    Effect.flatMap((cycle) =>
      Effect.fromResult(
        pipe(Option.getOrNull(cycle), (value) =>
          requireValue(value, {
            _tag: 'CycleMissing',
            failure: 'cycle-missing',
            source: 'cycle-store',
            cycleId,
          }),
        ),
      ),
    ),
  )

const readDecisionDocument = (
  store: CycleStore['Service'],
  cycleId: string,
): Effect.Effect<ObserveShadowDecisionDocument, CycleStoreError | PaperCandidateDiscoveryError, never> =>
  pipe(
    store.readDecisionDocument(cycleId),
    Effect.flatMap((document) =>
      Effect.fromResult(
        pipe(Option.getOrNull(document), (value) =>
          requireValue(value, { _tag: 'DocumentMissing', failure: 'document-missing', cycleId }),
        ),
      ),
    ),
  )

const readSnapshotTransaction = (
  identity: PaperCandidateDiscoveryIdentity,
  observability: CycleObservability['Service'],
  store: CycleStore['Service'],
): Effect.Effect<
  PaperCandidateDiscoverySnapshot,
  CycleObservabilityError | CycleStoreError | PaperCandidateDiscoveryError
> =>
  pipe(
    Effect.Do,
    Effect.bind('projection', () => observability.read(identity.qualificationRunId, identity.accountId)),
    Effect.bind('last', ({ projection }) => Effect.fromResult(selectCompletedCycle(projection))),
    Effect.bind('cycle', ({ last }) => readCycle(store, last.cycleId)),
    Effect.bind('document', ({ last }) => readDecisionDocument(store, last.cycleId)),
    Effect.map(({ cycle, document, projection }) => ({ cycle, document, projection })),
  )

const readDiscoverySnapshot = (
  identity: PaperCandidateDiscoveryIdentity,
): Effect.Effect<
  PaperCandidateDiscoverySnapshot,
  PaperCandidateDiscoveryError,
  PgClient.PgClient | CycleObservability | CycleStore
> =>
  pipe(
    Effect.all({
      sql: PgClient.PgClient,
      observability: CycleObservability,
      store: CycleStore,
    }),
    Effect.flatMap(({ observability, sql, store }) =>
      sql.withTransaction(
        pipe(
          sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
          Effect.andThen(readSnapshotTransaction(identity, observability, store)),
        ),
      ),
    ),
    Effect.mapError((cause) =>
      isPaperCandidateDiscoveryError(cause)
        ? cause
        : {
            _tag: 'SnapshotTransactionFailed',
            failure: 'transaction',
            accountId: identity.accountId,
            qualificationRunId: identity.qualificationRunId,
            cause,
          },
    ),
  )

const validateCycleProjection = (
  identity: PaperCandidateDiscoveryIdentity,
  snapshot: PaperCandidateDiscoverySnapshot,
  last: NonNullable<CycleOperationsProjection['last']>,
  terminalAt: string,
): Result.Result<void, PaperCandidateDiscoveryError> => {
  const { cycle } = snapshot
  return pipe(
    Result.all([
      requireCondition(last.phase === CycleState.Completed, {
        _tag: 'CycleStateMismatch',
        failure: 'cycle-mismatch',
        source: 'projection',
        observedState: last.phase,
      }),
      requireCondition(cycle.state === CycleState.Completed, {
        _tag: 'CycleStateMismatch',
        failure: 'cycle-mismatch',
        source: 'cycle-store',
        observedState: cycle.state,
      }),
      requireCondition(last.cycleId === cycle.identity.cycleId, {
        _tag: 'CycleIdentityMismatch',
        failure: 'cycle-mismatch',
        expectedCycleId: last.cycleId,
        observedCycleId: cycle.identity.cycleId,
      }),
      requireCondition(last.accountId === identity.accountId && cycle.identity.accountId === identity.accountId, {
        _tag: 'CycleAccountMismatch',
        failure: 'cycle-mismatch',
        expectedAccountId: identity.accountId,
        projectedAccountId: last.accountId,
        storedAccountId: cycle.identity.accountId,
      }),
      requireCondition(cycle.identity.qualificationRunId === identity.qualificationRunId, {
        _tag: 'CycleQualificationMismatch',
        failure: 'cycle-mismatch',
        expectedQualificationRunId: identity.qualificationRunId,
        observedQualificationRunId: cycle.identity.qualificationRunId,
      }),
      requireCondition(cycle.identity.strategyProtocolHash === identity.strategyProtocolHash, {
        _tag: 'CycleStrategyMismatch',
        failure: 'cycle-mismatch',
        expectedStrategyProtocolHash: identity.strategyProtocolHash,
        observedStrategyProtocolHash: cycle.identity.strategyProtocolHash,
      }),
      requireCondition(
        last.signalSessionDate === cycle.identity.signalSessionDate &&
          last.executionSessionDate === cycle.identity.executionSessionDate &&
          last.submissionOpenAt === cycle.window.submissionOpenAt &&
          last.submissionCutoffAt === cycle.window.submissionCutoffAt &&
          last.executionOpenAt === cycle.window.executionOpenAt &&
          last.executionCloseAt === cycle.window.executionCloseAt &&
          last.terminalAt === terminalAt,
        {
          _tag: 'CycleChronologyMismatch',
          failure: 'cycle-mismatch',
          cycleId: cycle.identity.cycleId,
          projected: {
            signalSessionDate: last.signalSessionDate,
            executionSessionDate: last.executionSessionDate,
            submissionOpenAt: last.submissionOpenAt,
            submissionCutoffAt: last.submissionCutoffAt,
            executionOpenAt: last.executionOpenAt,
            executionCloseAt: last.executionCloseAt,
            terminalAt: last.terminalAt,
          },
          stored: {
            signalSessionDate: cycle.identity.signalSessionDate,
            executionSessionDate: cycle.identity.executionSessionDate,
            submissionOpenAt: cycle.window.submissionOpenAt,
            submissionCutoffAt: cycle.window.submissionCutoffAt,
            executionOpenAt: cycle.window.executionOpenAt,
            executionCloseAt: cycle.window.executionCloseAt,
            terminalAt,
          },
        },
      ),
    ]),
    Result.map(() => undefined),
  )
}

const validateDocumentBinding = (
  identity: PaperCandidateDiscoveryIdentity,
  snapshot: PaperCandidateDiscoverySnapshot,
  last: NonNullable<CycleOperationsProjection['last']>,
  snapshotId: string,
  decisionHash: string,
  now: number,
): Result.Result<void, PaperCandidateDiscoveryError> => {
  const { cycle, document } = snapshot
  return pipe(
    Result.all([
      requireCondition(snapshotId === last.snapshotId && snapshotId === document.bindings.snapshotId, {
        _tag: 'SnapshotBindingMismatch',
        failure: 'document-mismatch',
        storedSnapshotId: snapshotId,
        projectedSnapshotId: last.snapshotId,
        documentSnapshotId: document.bindings.snapshotId,
      }),
      requireCondition(decisionHash === last.decisionHash && decisionHash === document.contentHash, {
        _tag: 'DecisionBindingMismatch',
        failure: 'document-mismatch',
        storedDecisionHash: decisionHash,
        projectedDecisionHash: last.decisionHash,
        documentContentHash: document.contentHash,
      }),
      requireCondition(
        document.bindings.cycleId === cycle.identity.cycleId &&
          document.bindings.accountId === identity.accountId &&
          document.bindings.strategyName === identity.strategy.name &&
          document.bindings.strategyProtocolHash === identity.strategyProtocolHash,
        {
          _tag: 'DocumentIdentityMismatch',
          failure: 'document-mismatch',
          expected: {
            cycleId: cycle.identity.cycleId,
            accountId: identity.accountId,
            strategyName: identity.strategy.name,
            strategyProtocolHash: identity.strategyProtocolHash,
          },
          observed: {
            cycleId: document.bindings.cycleId,
            accountId: document.bindings.accountId,
            strategyName: document.bindings.strategyName,
            strategyProtocolHash: document.bindings.strategyProtocolHash,
          },
        },
      ),
      requireCondition(document.bindings.policyHash === identity.policyHash, {
        _tag: 'DocumentPolicyMismatch',
        failure: 'document-mismatch',
        expectedPolicyHash: identity.policyHash,
        observedPolicyHash: document.bindings.policyHash,
      }),
      requireCondition(
        document.targetPlan.status === TargetPlanStatus.Planned && document.targetPlan.intentTargets.length > 0,
        {
          _tag: 'TargetPlanUnavailable',
          failure: 'document-mismatch',
          status: document.targetPlan.status,
          intentTargetCount: document.targetPlan.intentTargets.length,
        },
      ),
      requireCondition(document.deltaRisk.length === document.targetPlan.intentTargets.length, {
        _tag: 'RiskCountMismatch',
        failure: 'risk-mismatch',
        deltaRiskCount: document.deltaRisk.length,
        intentTargetCount: document.targetPlan.intentTargets.length,
      }),
      requireCondition(
        document.submissionCutoffAt === cycle.window.submissionCutoffAt &&
          document.expiresAt === cycle.window.submissionCutoffAt,
        {
          _tag: 'DocumentCutoffMismatch',
          failure: 'document-mismatch',
          cycleSubmissionCutoffAt: cycle.window.submissionCutoffAt,
          documentSubmissionCutoffAt: document.submissionCutoffAt,
          documentExpiresAt: document.expiresAt,
        },
      ),
      requireCondition(now < Date.parse(document.expiresAt), {
        _tag: 'DocumentStale',
        failure: 'document-stale',
        observedAtMs: now,
        expiresAt: document.expiresAt,
      }),
    ]),
    Result.map(() => undefined),
  )
}

const validateAuthority = (
  identity: PaperCandidateDiscoveryIdentity,
  projection: CycleOperationsProjection,
): Result.Result<void, PaperCandidateDiscoveryError> => {
  const authority = projection.authority
  return requireCondition(
    authority !== null &&
      authority.generationHash === identity.authorityGenerationHash &&
      authority.maximum === Authority.Observe &&
      authority.effective === Authority.Observe,
    {
      _tag: 'AuthorityMismatch',
      failure: 'authority-mismatch',
      expectedGenerationHash: identity.authorityGenerationHash,
      observedGenerationHash: authority?.generationHash ?? null,
      observedMaximum: authority?.maximum ?? null,
      observedEffective: authority?.effective ?? null,
    },
  )
}

const validateRisk = (document: ObserveShadowDecisionDocument): Result.Result<void, PaperCandidateDiscoveryError> =>
  pipe(
    document.deltaRisk.map((risk, index) => {
      const failed = risk.evaluation.gates.filter((gate) => !gate.passed)
      return requireCondition(
        risk.evaluation.decision.outcome === RiskOutcome.Blocked &&
          risk.evaluation.decision.reasonCodes.length === 1 &&
          risk.evaluation.decision.reasonCodes[0] === Reason.AuthorityNotPaper &&
          failed.length === 1 &&
          failed[0]?.name === Gate.Authority &&
          failed[0]?.reason === Reason.AuthorityNotPaper,
        {
          _tag: 'RiskAuthorityMismatch',
          failure: 'risk-mismatch',
          index,
          outcome: risk.evaluation.decision.outcome,
          reasonCodes: risk.evaluation.decision.reasonCodes,
          failedGates: failed.map(({ name, reason }) => ({ name, reason })),
        },
      )
    }),
    Result.all,
    Result.map(() => undefined),
  )

const validateReconciliation = (
  identity: PaperCandidateDiscoveryIdentity,
  snapshot: PaperCandidateDiscoverySnapshot,
  reconciliation: NonNullable<CycleOperationsProjection['reconciliation']>,
): Result.Result<void, PaperCandidateDiscoveryError> =>
  pipe(
    Result.all([
      requireCondition(
        reconciliation.accountId === identity.accountId &&
          reconciliation.reconciliationId === snapshot.document.bindings.reconciliationId &&
          reconciliation.status === 'EXACT' &&
          reconciliation.discrepancyCount === 0 &&
          reconciliation.coversLatestMutation,
        {
          _tag: 'ReconciliationMismatch',
          failure: 'document-mismatch',
          expectedAccountId: identity.accountId,
          observedAccountId: reconciliation.accountId,
          expectedReconciliationId: snapshot.document.bindings.reconciliationId,
          observedReconciliationId: reconciliation.reconciliationId,
          status: reconciliation.status,
          discrepancyCount: reconciliation.discrepancyCount,
          coversLatestMutation: reconciliation.coversLatestMutation,
        },
      ),
      requireCondition(snapshot.projection.mutations.unresolvedCount === 0, {
        _tag: 'UnresolvedMutations',
        failure: 'document-mismatch',
        unresolvedMutationCount: snapshot.projection.mutations.unresolvedCount,
        reconciliationId: reconciliation.reconciliationId,
      }),
    ]),
    Result.map(() => undefined),
  )

const assembleBinding = (
  identity: PaperCandidateDiscoveryIdentity,
  snapshot: PaperCandidateDiscoverySnapshot,
  terminalAt: string,
  snapshotId: string,
): PaperCandidateDiscoveryBinding => ({
  schemaVersion: bindingSchemaVersion,
  runtime: identity,
  cycle: {
    cycleId: snapshot.cycle.identity.cycleId,
    signalSessionDate: snapshot.cycle.identity.signalSessionDate,
    executionSessionDate: snapshot.cycle.identity.executionSessionDate,
    snapshotId,
    decisionHash: snapshot.document.contentHash,
    submissionCutoffAt: snapshot.cycle.window.submissionCutoffAt,
    terminalAt,
  },
  document: {
    contentHash: snapshot.document.contentHash,
    snapshotContentHash: snapshot.document.bindings.snapshotContentHash,
    snapshotFinalizedAt: snapshot.document.bindings.snapshotFinalizedAt,
    strategyDecisionHash: snapshot.document.bindings.strategyDecisionHash,
    policyHash: snapshot.document.bindings.policyHash,
    planningBrokerStateHash: snapshot.document.bindings.planningBrokerStateHash,
    reconciliationId: snapshot.document.bindings.reconciliationId,
    reconciliationHash: snapshot.document.bindings.reconciliationHash,
    targetPlanInputHash: snapshot.document.targetPlan.inputHash,
    targetPlanOutputHash: snapshot.document.targetPlan.outputHash,
    createdAt: snapshot.document.createdAt,
    expiresAt: snapshot.document.expiresAt,
  },
})

const validateSnapshotForIdentity = (
  identity: PaperCandidateDiscoveryIdentity,
  snapshot: PaperCandidateDiscoverySnapshot,
  now: number,
): Result.Result<ValidatedPaperCandidateSnapshot, PaperCandidateDiscoveryError> =>
  pipe(
    Result.Do,
    Result.bind('last', () =>
      requireValue(snapshot.projection.last, {
        _tag: 'CycleMissing',
        failure: 'cycle-missing',
        source: 'projection',
        cycleId: null,
      }),
    ),
    Result.bind('terminalAt', () =>
      requireValue(snapshot.cycle.terminalAt, {
        _tag: 'CycleTerminalAtMissing',
        failure: 'cycle-mismatch',
        cycleId: snapshot.cycle.identity.cycleId,
      }),
    ),
    Result.bind('snapshotId', () =>
      requireValue(snapshot.cycle.bindings.snapshotId, {
        _tag: 'CycleBindingMissing',
        failure: 'document-mismatch',
        binding: 'snapshot',
        cycleId: snapshot.cycle.identity.cycleId,
      }),
    ),
    Result.bind('decisionHash', () =>
      requireValue(snapshot.cycle.bindings.decisionHash, {
        _tag: 'CycleBindingMissing',
        failure: 'document-mismatch',
        binding: 'decision',
        cycleId: snapshot.cycle.identity.cycleId,
      }),
    ),
    Result.bind('reconciliation', () =>
      requireValue(snapshot.projection.reconciliation, {
        _tag: 'ReconciliationMissing',
        failure: 'document-mismatch',
        accountId: identity.accountId,
      }),
    ),
    Result.flatMap(({ decisionHash, last, reconciliation, snapshotId, terminalAt }) =>
      pipe(
        Result.all([
          validateCycleProjection(identity, snapshot, last, terminalAt),
          validateDocumentBinding(identity, snapshot, last, snapshotId, decisionHash, now),
          validateAuthority(identity, snapshot.projection),
          validateRisk(snapshot.document),
          validateReconciliation(identity, snapshot, reconciliation),
        ]),
        Result.map(() => ({
          [ValidatedSnapshotTypeId]: true as const,
          identity,
          snapshot,
          binding: assembleBinding(identity, snapshot, terminalAt, snapshotId),
        })),
      ),
    ),
  )

export const validatePaperCandidateDiscoverySnapshot = (
  identity: PaperCandidateDiscoveryIdentity,
  snapshot: PaperCandidateDiscoverySnapshot,
  now: number,
): Result.Result<ValidatedPaperCandidateSnapshot, PaperCandidateDiscoveryError> =>
  pipe(
    validateIdentity(identity),
    Result.flatMap((validatedIdentity) => validateSnapshotForIdentity(validatedIdentity, snapshot, now)),
  )

const accountFacts = (account: Account): typeof AccountFactsSchema.Type => ({
  id: account.id,
  status: account.status,
  currency: account.currency,
  cashMicros: account.cashMicros,
  equityMicros: account.equityMicros,
  buyingPowerMicros: account.buyingPowerMicros,
  accountBlocked: account.accountBlocked,
  tradingBlocked: account.tradingBlocked,
  tradeSuspendedByUser: account.tradeSuspendedByUser,
})

const accountConfigurationFacts = (
  configuration: AccountConfigurationObservation,
): typeof AccountConfigurationFactsSchema.Type => ({
  schemaVersion: configuration.schemaVersion,
  source: configuration.source,
  requestHash: configuration.requestHash,
  fractionalTrading: configuration.fractionalTrading,
  normalizedResponseHash: configuration.normalizedResponseHash,
})

const assetFacts = (asset: AssetObservation): typeof AssetFactsSchema.Type => ({
  schemaVersion: asset.schemaVersion,
  source: asset.source,
  requestedSymbol: asset.requestedSymbol,
  requestHash: asset.requestHash,
  assetId: asset.assetId,
  symbol: asset.symbol,
  assetClass: asset.assetClass,
  exchange: asset.exchange,
  status: asset.status,
  tradable: asset.tradable,
  fractionable: asset.fractionable,
  attributes: asset.attributes,
  normalizedResponseHash: asset.normalizedResponseHash,
})

const assetEligibilityRules = [
  [PaperCandidateIneligibility.AssetClass, (asset: AssetObservation) => asset.assetClass !== AssetClass.UsEquity],
  [PaperCandidateIneligibility.Inactive, (asset: AssetObservation) => asset.status !== AssetStatus.Active],
  [PaperCandidateIneligibility.NotTradable, (asset: AssetObservation) => !asset.tradable],
  [PaperCandidateIneligibility.NotFractionable, (asset: AssetObservation) => !asset.fractionable],
  [PaperCandidateIneligibility.Otc, (asset: AssetObservation) => asset.exchange === AssetExchange.Otc],
  [PaperCandidateIneligibility.Ipo, (asset: AssetObservation) => asset.attributes.includes('ipo')],
  [
    PaperCandidateIneligibility.PtpNoException,
    (asset: AssetObservation) => asset.attributes.includes('ptp_no_exception'),
  ],
] as const

const assetEligibility = (
  asset: AssetObservation,
): Result.Result<
  {
    readonly eligible: boolean
    readonly reasons: ReadonlyArray<PaperCandidateIneligibility>
  },
  never
> => {
  const reasons = assetEligibilityRules.flatMap(([reason, applies]) => (applies(asset) ? [reason] : []))
  return Result.succeed({ eligible: reasons.length === 0, reasons })
}

const validateReadEvidence = <A extends { readonly observedAt: string }>(
  result: ReadResult<A>,
  identity:
    | { readonly observation: 'account' | 'account-configuration'; readonly symbol: null }
    | { readonly observation: 'asset'; readonly symbol: string },
): Result.Result<ReadResult<A>, PaperCandidateDiscoveryError> =>
  pipe(
    requireCondition(result.value.observedAt === result.evidence.observedAt, {
      _tag: 'ObservationTimeMismatch',
      failure: 'broker',
      ...identity,
      valueObservedAt: result.value.observedAt,
      evidenceObservedAt: result.evidence.observedAt,
    }),
    Result.map(() => result),
  )

const normalizedReadEvidence = (evidence: ReadEvidence): typeof ReadEvidenceSchema.Type => {
  const rateLimit =
    evidence.rateLimit === undefined
      ? {}
      : {
          ...(evidence.rateLimit.limit === undefined ? {} : { limit: evidence.rateLimit.limit }),
          ...(evidence.rateLimit.remaining === undefined ? {} : { remaining: evidence.rateLimit.remaining }),
          ...(evidence.rateLimit.reset === undefined ? {} : { reset: evidence.rateLimit.reset }),
          ...(evidence.rateLimit.retryAfter === undefined ? {} : { retryAfter: evidence.rateLimit.retryAfter }),
        }
  return {
    requestId: evidence.requestId,
    status: evidence.status,
    contentHash: evidence.contentHash,
    observedAt: evidence.observedAt,
    ...(Object.keys(rateLimit).length === 0 ? {} : { rateLimit }),
  }
}

const validateAccountObservation = (
  identity: PaperCandidateDiscoveryIdentity,
  account: ReadResult<Account>,
): Result.Result<ValidatedAccount, PaperCandidateDiscoveryError> =>
  pipe(
    Result.all([
      requireCondition(account.value.id === identity.accountId, {
        _tag: 'AccountMismatch',
        failure: 'account-mismatch',
        expectedAccountId: identity.accountId,
        observedAccountId: account.value.id,
      }),
      validateReadEvidence(account, { observation: 'account', symbol: null }),
    ]),
    Result.map(() => ({ [ValidatedAccountTypeId]: true as const, read: account })),
  )

const validateAccountConfiguration = (
  account: ValidatedAccount,
  configuration: ReadResult<AccountConfigurationObservation>,
): Result.Result<ValidatedAccountConfiguration, PaperCandidateDiscoveryError> =>
  pipe(
    Result.all([
      validateReadEvidence(configuration, { observation: 'account-configuration', symbol: null }),
      requireCondition(Date.parse(configuration.value.observedAt) >= Date.parse(account.read.value.observedAt), {
        _tag: 'ObservationChronologyMismatch',
        failure: 'broker',
        earlier: 'account',
        later: 'account-configuration',
        symbol: null,
        earlierObservedAt: account.read.value.observedAt,
        laterObservedAt: configuration.value.observedAt,
      }),
    ]),
    Result.map(() => ({
      [ValidatedAccountConfigurationTypeId]: true as const,
      read: configuration,
    })),
  )

const validateAssetObservation = (
  symbol: string,
  ordinal: number,
  accountConfigurationObservedAt: string,
  asset: ReadResult<AssetObservation> | undefined,
): Result.Result<ReadResult<AssetObservation>, PaperCandidateDiscoveryError> =>
  pipe(
    requireValue(asset, { _tag: 'AssetMissing', failure: 'broker', ordinal, symbol }),
    Result.flatMap((observed) =>
      pipe(
        Result.all([
          validateReadEvidence(observed, { observation: 'asset', symbol }),
          requireCondition(observed.value.requestedSymbol === symbol && observed.value.symbol === symbol, {
            _tag: 'AssetSymbolMismatch',
            failure: 'broker',
            ordinal,
            plannedSymbol: symbol,
            requestedSymbol: observed.value.requestedSymbol,
            observedSymbol: observed.value.symbol,
          }),
          requireCondition(Date.parse(observed.value.observedAt) >= Date.parse(accountConfigurationObservedAt), {
            _tag: 'ObservationChronologyMismatch',
            failure: 'broker',
            earlier: 'account-configuration',
            later: 'asset',
            symbol,
            earlierObservedAt: accountConfigurationObservedAt,
            laterObservedAt: observed.value.observedAt,
          }),
        ]),
        Result.map(() => observed),
      ),
    ),
  )

const validateAssetObservations = (
  snapshot: PaperCandidateDiscoverySnapshot,
  configuration: ValidatedAccountConfiguration,
  assets: ReadonlyArray<ReadResult<AssetObservation>>,
): Result.Result<ValidatedAssets, PaperCandidateDiscoveryError> =>
  pipe(
    requireCondition(assets.length === snapshot.document.targetPlan.intentTargets.length, {
      _tag: 'AssetCountMismatch',
      failure: 'broker',
      expectedAssetCount: snapshot.document.targetPlan.intentTargets.length,
      observedAssetCount: assets.length,
    }),
    Result.flatMap(() =>
      pipe(
        snapshot.document.targetPlan.intentTargets.map((intent, ordinal) =>
          validateAssetObservation(intent.symbol, ordinal, configuration.read.value.observedAt, assets[ordinal]),
        ),
        Result.all,
      ),
    ),
    Result.map((reads) => ({ [ValidatedAssetsTypeId]: true as const, reads })),
  )

const makeCandidate = (
  snapshot: PaperCandidateDiscoverySnapshot,
  configuration: ValidatedAccountConfiguration,
  assets: ValidatedAssets,
  ordinal: number,
): Result.Result<typeof CandidateFactsSchema.Type, PaperCandidateDiscoveryError> => {
  const intent = snapshot.document.targetPlan.intentTargets[ordinal]
  return pipe(
    requireValue(intent, {
      _tag: 'CandidateMaterialMissing',
      failure: 'document-mismatch',
      material: 'intent',
      ordinal,
      symbol: null,
    }),
    Result.flatMap((plannedIntent) =>
      pipe(
        Result.Do,
        Result.bind('target', () =>
          requireValue(
            snapshot.document.targetPlan.targets.find((candidate) => candidate.symbol === plannedIntent.symbol),
            {
              _tag: 'CandidateMaterialMissing',
              failure: 'document-mismatch',
              material: 'target',
              ordinal,
              symbol: plannedIntent.symbol,
            },
          ),
        ),
        Result.bind('risk', () =>
          requireValue(snapshot.document.deltaRisk[ordinal], {
            _tag: 'CandidateMaterialMissing',
            failure: 'risk-mismatch',
            material: 'risk',
            ordinal,
            symbol: plannedIntent.symbol,
          }),
        ),
        Result.bind('asset', () =>
          requireValue(assets.reads[ordinal], {
            _tag: 'AssetMissing',
            failure: 'broker',
            ordinal,
            symbol: plannedIntent.symbol,
          }),
        ),
        Result.bind('eligibility', ({ asset }) => assetEligibility(asset.value)),
        Result.map(({ asset, eligibility, risk, target }) => ({
          ordinal,
          observedPlanIntentId: risk.evaluation.input.intentId,
          symbol: plannedIntent.symbol,
          side: plannedIntent.side,
          orderType: plannedIntent.orderType,
          timeInForce: plannedIntent.timeInForce,
          observedPlannedQuantityMicros: plannedIntent.quantityMicros,
          observedReferencePriceMicros: target.referencePriceMicros,
          observedNotionalLimitMicros: risk.notionalLimitMicros,
          observedEvaluatedOrderNotionalMicros: risk.evaluation.metrics.orderNotionalMicros,
          observedTargetWeight: target.targetWeight,
          observedCurrentQuantityMicros: target.currentQuantityMicros,
          observedTargetQuantityMicros: target.targetQuantityMicros,
          observedRiskDecisionId: risk.evaluation.decision.decisionId,
          observedRiskInputHash: risk.evaluation.input.inputHash,
          asset: assetFacts(asset.value),
          assetEligibility: eligibility,
          fractionalTradingEligible: configuration.read.value.fractionalTrading && eligibility.eligible,
        })),
      ),
    ),
  )
}

const makeCandidates = (
  snapshot: PaperCandidateDiscoverySnapshot,
  configuration: ValidatedAccountConfiguration,
  assets: ValidatedAssets,
): Result.Result<ReadonlyArray<typeof CandidateFactsSchema.Type>, PaperCandidateDiscoveryError> =>
  pipe(
    snapshot.document.targetPlan.intentTargets.map((_, ordinal) =>
      makeCandidate(snapshot, configuration, assets, ordinal),
    ),
    Result.all,
  )

const decodeReceipt = (
  material: typeof DiscoveryReceiptMaterialSchema.Type,
): Result.Result<PaperCandidateDiscoveryReceipt, PaperCandidateDiscoveryError> =>
  pipe(
    canonicalHashResult(
      material,
      (cause): PaperCandidateDiscoveryError => ({
        _tag: 'ReceiptHashFailed',
        failure: 'output',
        schemaVersion: material.schemaVersion,
        candidateFactsHash: material.candidateFactsHash,
        cause,
      }),
    ),
    Result.flatMap((observationReceiptHash) =>
      pipe(
        Schema.decodeUnknownResult(
          DiscoveryReceiptSchema,
          strictParseOptions,
        )({
          ...material,
          observationReceiptHash,
        }),
        Result.mapError(
          (cause): PaperCandidateDiscoveryError => ({
            _tag: 'ReceiptDecodeFailed',
            failure: 'output',
            schemaVersion: material.schemaVersion,
            candidateFactsHash: material.candidateFactsHash,
            cause,
          }),
        ),
      ),
    ),
  )

const assembleValidatedObservations = (
  validatedSnapshot: ValidatedPaperCandidateSnapshot,
  account: ValidatedAccount,
  accountConfiguration: ValidatedAccountConfiguration,
  assets: ValidatedAssets,
  capturedAtMs: number,
): Result.Result<ValidatedPaperCandidateObservations, PaperCandidateDiscoveryError> =>
  pipe(
    requireCondition(capturedAtMs < Date.parse(validatedSnapshot.snapshot.document.expiresAt), {
      _tag: 'DocumentStale',
      failure: 'document-stale',
      observedAtMs: capturedAtMs,
      expiresAt: validatedSnapshot.snapshot.document.expiresAt,
    }),
    Result.map(() => ({
      [ValidatedObservationsTypeId]: true as const,
      account,
      accountConfiguration,
      assets,
      capturedAt: new Date(capturedAtMs).toISOString(),
    })),
  )

export const validatePaperCandidateDiscoveryObservations = (
  validatedSnapshot: ValidatedPaperCandidateSnapshot,
  input: {
    readonly account: ReadResult<Account>
    readonly accountConfiguration: ReadResult<AccountConfigurationObservation>
    readonly assets: ReadonlyArray<ReadResult<AssetObservation>>
    readonly capturedAtMs: number
  },
): Result.Result<ValidatedPaperCandidateObservations, PaperCandidateDiscoveryError> =>
  pipe(
    Result.Do,
    Result.bind('account', () => validateAccountObservation(validatedSnapshot.identity, input.account)),
    Result.bind('accountConfiguration', ({ account }) =>
      validateAccountConfiguration(account, input.accountConfiguration),
    ),
    Result.bind('assets', ({ accountConfiguration }) =>
      validateAssetObservations(validatedSnapshot.snapshot, accountConfiguration, input.assets),
    ),
    Result.flatMap(({ account, accountConfiguration, assets }) =>
      assembleValidatedObservations(validatedSnapshot, account, accountConfiguration, assets, input.capturedAtMs),
    ),
  )

const makePaperCandidateDiscoveryReceipt = (
  validatedSnapshot: ValidatedPaperCandidateSnapshot,
  observations: ValidatedPaperCandidateObservations,
): Result.Result<PaperCandidateDiscoveryReceipt, PaperCandidateDiscoveryError> => {
  const { binding, snapshot } = validatedSnapshot
  return pipe(
    Result.Do,
    Result.bind('candidates', () => makeCandidates(snapshot, observations.accountConfiguration, observations.assets)),
    Result.bind('immutableBindingHash', () =>
      canonicalHashResult(
        binding,
        (cause): PaperCandidateDiscoveryError => ({
          _tag: 'BindingHashFailed',
          failure: 'output',
          cycleId: binding.cycle.cycleId,
          documentContentHash: binding.document.contentHash,
          cause,
        }),
      ),
    ),
    Result.bind('candidateFacts', ({ candidates, immutableBindingHash }) =>
      pipe(
        {
          schemaVersion: candidateFactsSchemaVersion,
          immutableBindingHash,
          account: accountFacts(observations.account.read.value),
          accountConfiguration: accountConfigurationFacts(observations.accountConfiguration.read.value),
          candidates,
          consistencyDelayMs: { status: 'REQUIRED_UNBOUND' as const },
        },
        Schema.decodeUnknownResult(CandidateFactsMaterialSchema, strictParseOptions),
        Result.mapError(
          (cause): PaperCandidateDiscoveryError => ({
            _tag: 'CandidateFactsDecodeFailed',
            failure: 'output',
            immutableBindingHash,
            candidateCount: candidates.length,
            cause,
          }),
        ),
      ),
    ),
    Result.bind('candidateFactsHash', ({ candidateFacts }) =>
      canonicalHashResult(
        candidateFacts,
        (cause): PaperCandidateDiscoveryError => ({
          _tag: 'CandidateFactsHashFailed',
          failure: 'output',
          immutableBindingHash: candidateFacts.immutableBindingHash,
          candidateCount: candidateFacts.candidates.length,
          cause,
        }),
      ),
    ),
    Result.flatMap(({ candidateFacts, candidateFactsHash, immutableBindingHash }) =>
      decodeReceipt({
        schemaVersion: discoverySchemaVersion,
        operation: 'PAPER_CANDIDATE_DISCOVERY',
        authority: Authority.Observe,
        dispatchable: false,
        binding,
        immutableBindingHash,
        candidateFacts,
        candidateFactsHash,
        observations: {
          account: {
            value: observations.account.read.value,
            evidence: normalizedReadEvidence(observations.account.read.evidence),
          },
          accountConfiguration: {
            value: observations.accountConfiguration.read.value,
            evidence: normalizedReadEvidence(observations.accountConfiguration.read.evidence),
          },
          assets: observations.assets.reads.map((asset, ordinal) => ({
            ordinal,
            value: asset.value,
            evidence: normalizedReadEvidence(asset.evidence),
          })),
        },
        capturedAt: observations.capturedAt,
        observationReceiptSchemaVersion,
      }),
    ),
  )
}

const readAccount = (
  broker: BrokerRead['Service'],
  identity: PaperCandidateDiscoveryIdentity,
): Effect.Effect<ValidatedAccount, PaperCandidateDiscoveryError> =>
  pipe(
    broker.account,
    Effect.mapError(
      (cause): PaperCandidateDiscoveryError => ({
        _tag: 'BrokerReadFailed',
        failure: 'broker',
        read: 'account',
        accountId: identity.accountId,
        cause,
      }),
    ),
    Effect.flatMap((account) => Effect.fromResult(validateAccountObservation(identity, account))),
  )

const readAccountConfiguration = (
  broker: BrokerRead['Service'],
  account: ValidatedAccount,
): Effect.Effect<ValidatedAccountConfiguration, PaperCandidateDiscoveryError> =>
  pipe(
    broker.accountConfiguration,
    Effect.mapError(
      (cause): PaperCandidateDiscoveryError => ({
        _tag: 'BrokerReadFailed',
        failure: 'broker',
        read: 'account-configuration',
        accountId: account.read.value.id,
        cause,
      }),
    ),
    Effect.flatMap((configuration) => Effect.fromResult(validateAccountConfiguration(account, configuration))),
  )

const readAssets = (
  broker: BrokerRead['Service'],
  snapshot: PaperCandidateDiscoverySnapshot,
  configuration: ValidatedAccountConfiguration,
): Effect.Effect<ValidatedAssets, PaperCandidateDiscoveryError> =>
  pipe(
    Effect.forEach(snapshot.document.targetPlan.intentTargets, (intent) => broker.assetBySymbol(intent.symbol), {
      concurrency: assetReadConcurrency,
    }),
    Effect.mapError(
      (cause): PaperCandidateDiscoveryError => ({
        _tag: 'BrokerReadFailed',
        failure: 'broker',
        read: 'assets',
        accountId: snapshot.cycle.identity.accountId,
        symbols: snapshot.document.targetPlan.intentTargets.map(({ symbol }) => symbol),
        cause,
      }),
    ),
    Effect.flatMap((assets) => Effect.fromResult(validateAssetObservations(snapshot, configuration, assets))),
  )

const observeBroker = (
  validatedSnapshot: ValidatedPaperCandidateSnapshot,
): Effect.Effect<ValidatedPaperCandidateObservations, PaperCandidateDiscoveryError, BrokerRead> =>
  pipe(
    BrokerRead,
    Effect.flatMap((broker) =>
      pipe(
        Effect.Do,
        Effect.bind('account', () => readAccount(broker, validatedSnapshot.identity)),
        Effect.bind('accountConfiguration', ({ account }) => readAccountConfiguration(broker, account)),
        Effect.bind('assets', ({ accountConfiguration }) =>
          readAssets(broker, validatedSnapshot.snapshot, accountConfiguration),
        ),
        Effect.bind('capturedAtMs', () => Clock.currentTimeMillis),
        Effect.flatMap(({ account, accountConfiguration, assets, capturedAtMs }) =>
          Effect.fromResult(
            assembleValidatedObservations(validatedSnapshot, account, accountConfiguration, assets, capturedAtMs),
          ),
        ),
      ),
    ),
  )

export const discoverPaperCandidates = (
  candidateIdentity: PaperCandidateDiscoveryIdentity,
): Effect.Effect<
  PaperCandidateDiscoveryReceipt,
  PaperCandidateDiscoveryError,
  PgClient.PgClient | CycleObservability | CycleStore | BrokerRead
> =>
  pipe(
    validateIdentity(candidateIdentity),
    Effect.fromResult,
    Effect.flatMap((identity) =>
      pipe(
        Effect.Do,
        Effect.bind('snapshot', () => readDiscoverySnapshot(identity)),
        Effect.bind('startedAt', () => Clock.currentTimeMillis),
        Effect.bind('validatedSnapshot', ({ snapshot, startedAt }) =>
          Effect.fromResult(validateSnapshotForIdentity(identity, snapshot, startedAt)),
        ),
        Effect.bind('observations', ({ validatedSnapshot }) => observeBroker(validatedSnapshot)),
        Effect.flatMap(({ observations, validatedSnapshot }) =>
          Effect.fromResult(makePaperCandidateDiscoveryReceipt(validatedSnapshot, observations)),
        ),
      ),
    ),
  )
