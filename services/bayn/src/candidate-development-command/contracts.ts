import { Effect, Schema } from 'effect'
import {
  candidateDevelopmentComparisonSemantics,
  type CandidateDevelopmentEffects,
  type CandidateDevelopmentEvaluation,
  type CandidateDevelopmentPreflightPass,
  type CandidateDevelopmentPreflightInput,
  type CandidateDevelopmentReport,
  type CandidateDevelopmentRunFailure,
} from '../candidate-development'
import { type CandidateDevelopmentDecision as CandidateDevelopmentCommandDecision } from '../candidate-development-decision'
import {
  DailyPerformanceSeriesArtifactSchema,
  DailyPositionMarksArtifactSchema,
  DecisionPlanSchema,
  EquitySeriesArtifactSchema,
  EvaluationEventsSchema,
  EvaluationSummarySchema,
  InputManifestArtifactSchema,
  MarkedEquityReconciliationSchema,
  RiskBalancedTrendSignalDecisionsArtifactSchema,
} from '../evidence-contracts'
import { type CanonicalHashFailure } from '../hash'
import { DIRECT_VOLATILITY_WINDOW, ExecutionModelSchema } from '../protocol'
import {
  DigitsSchema,
  IsoDateSchema,
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SignedMicrosSchema,
  SourceRevisionSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnitIntervalSchema,
  strictParseOptions,
} from '../schemas'
import {
  DataFeed,
  DataSource,
  PriceAdjustment,
  PublicationSchema,
  type DailyBar,
  type DecisionPlan,
  type EvaluationResult,
  type IsoDate,
  type SimulationProtocol,
} from '../types'

export const candidateDevelopmentExecutableProgramSchemaVersion =
  'bayn.candidate-development-executable-program.v5' as const

export interface CandidateDevelopmentSourceManifest {
  readonly schemaVersion: 'bayn.candidate-development-source-manifest.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
  readonly strategyIdentityHash?: string
  readonly candidateDevelopmentProtocolHash?: string
  readonly calendarHash?: string
  readonly priorTrialsHash?: string
  readonly modulePath: string
  readonly moduleSha256?: string
  readonly moduleFormat: 'self-contained-esm-v1'
  readonly marketData: {
    readonly schemaVersion: 'bayn.candidate-development-market-data-source.v1'
    readonly snapshotId: string
    readonly finalizedSnapshotContentHash: string
    readonly inputManifestHash: string
    readonly boundedContentHash: string
  }
}

export interface CandidateDevelopmentArtifactStructuralBindings {
  readonly schemaVersion: 'bayn.candidate-development-artifact-structural-bindings.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
  readonly strategyIdentityHash: string
  readonly candidateDevelopmentProtocolHash: string
  readonly calendarHash: string
  readonly priorTrialsHash: string
  readonly modulePath: string
  readonly sourceManifestPath: string
}

export interface CandidateDevelopmentMomentumStrategyIdentity {
  readonly schemaVersion: 'bayn.candidate-development-strategy-identity.v1'
  readonly family: string
  readonly identifier: string
  readonly researchSources: readonly [string, string, string]
  readonly parameters: {
    readonly id: string
    readonly lookbackSessions: number
    readonly volatilityWindowSessions: number
    readonly annualizationSessions: number
    readonly riskAssets: readonly [string, string]
    readonly defensiveAsset: string
    readonly absoluteMomentumThreshold: number
    readonly selectedAssetWeight: number
    readonly relativeMomentumTieBreak: string
  }
  readonly input: string
  readonly relativeMomentum: string
  readonly absoluteMomentum: string
  readonly defensive: string
  readonly allocation: string
  readonly schedule: string
  readonly terminal: string
  readonly missingData: string
  readonly doubledCost: string
}

export interface CandidateDevelopmentInverseVolatilityStrategyIdentity {
  readonly schemaVersion: 'bayn.candidate-development-strategy-identity.v2'
  readonly family: 'inverse-volatility-risk-diversification'
  readonly identifier: string
  readonly researchSources: readonly [string, string, string]
  readonly parameters: {
    readonly id: string
    readonly lookbackSessions: number
    readonly annualizationSessions: number
    readonly riskAssets: readonly [string, string]
    readonly covarianceEstimator: 'sample'
    readonly targetAnnualizedVolatility: number
    readonly maximumGrossExposure: number
  }
  readonly input: string
  readonly weighting: string
  readonly riskScaling: string
  readonly allocation: string
  readonly schedule: string
  readonly terminal: string
  readonly missingData: string
  readonly doubledCost: string
}

export type CandidateDevelopmentStrategyIdentity =
  | CandidateDevelopmentMomentumStrategyIdentity
  | CandidateDevelopmentInverseVolatilityStrategyIdentity

export interface CandidateDevelopmentVerifiedSource {
  readonly schemaVersion: 'bayn.candidate-development-verified-source.v1'
  readonly sourceRevision: string
  readonly modulePath: string
  readonly moduleBlobOid: string
  readonly moduleSha256: string
  readonly sourceManifestPath: string
  readonly sourceManifestBlobOid: string
  readonly sourceManifestSha256: string
  readonly sourceManifest: CandidateDevelopmentSourceManifest
  readonly baselineRunId: string
  readonly stressedRunId: string
}

export interface CandidateDevelopmentVerifiedSourceFiles extends Omit<
  CandidateDevelopmentVerifiedSource,
  'schemaVersion' | 'baselineRunId' | 'stressedRunId'
> {
  readonly schemaVersion: 'bayn.candidate-development-verified-source-files.v1'
}

export interface CandidateDevelopmentMarketDataWitness {
  readonly schemaVersion: 'bayn.candidate-development-market-data-witness.v1'
  readonly snapshotId: string
  readonly inputManifestHash: string
  readonly contentHash: string
  readonly bars: readonly DailyBar[]
}

export interface CandidateDevelopmentArtifactRuntimeInput extends CandidateDevelopmentVerifiedSource {
  readonly runtimeDataSchemaVersion: 'bayn.candidate-development-artifact-runtime-input.v1'
  readonly preflightInput: CandidateDevelopmentPreflightInput
  readonly marketData: CandidateDevelopmentMarketDataWitness
}

export interface CandidateDevelopmentPlannedDecision extends DecisionPlan {
  readonly executionDate: IsoDate
}

export interface CandidateDevelopmentStrategyPlan {
  readonly schemaVersion: 'bayn.candidate-development-strategy-plan.v1'
  readonly decisions: readonly CandidateDevelopmentPlannedDecision[]
}

export interface CandidateDevelopmentStrategyProtocol extends SimulationProtocol {
  readonly schemaVersion: 'bayn.candidate-development-strategy-protocol.v2'
  readonly marketData: {
    readonly schemaVersion: 'bayn.candidate-development-market-data-contract.v1'
    readonly snapshotId: string
    readonly contentHash: string
  }
  readonly benchmarks: {
    readonly schemaVersion: 'bayn.candidate-development-benchmark-policy.v1'
    readonly symbol: string
    readonly directVolatilityWindow: typeof DIRECT_VOLATILITY_WINDOW
    readonly terminalPolicy: 'last-all-cash-strategy-decision'
  }
  readonly strategyIdentity?: CandidateDevelopmentStrategyIdentity
}

export interface CandidateDevelopmentAccountingEvidence {
  readonly schemaVersion: 'bayn.candidate-development-accounting-evidence.v2'
  readonly runId: string
  readonly initialCapitalMicros: string
  readonly evaluatorTotalFeesMicros: string
  readonly evaluatorEndingEquityMicros: string
  readonly events: EvaluationResult['events']
  readonly baselineSimulation: EvaluationResult['simulation']
  readonly equitySeries: EvaluationResult['equitySeries']
  readonly markedEquityReconciliation: EvaluationResult['markedEquityReconciliation']
  readonly signalDecisions: EvaluationResult['signalDecisions']
  readonly stressedRunId: string
  readonly stressedEvaluatorTotalFeesMicros: string
  readonly stressedEvaluatorEndingEquityMicros: string
  readonly stressedEvents: EvaluationResult['events']
  readonly stressedSimulation: EvaluationResult['simulation']
  readonly stressedEquitySeries: EvaluationResult['equitySeries']
  readonly stressedMarkedEquityReconciliation: EvaluationResult['markedEquityReconciliation']
}

export interface CandidateDevelopmentCommandEvaluation extends CandidateDevelopmentEvaluation {
  readonly accounting: CandidateDevelopmentAccountingEvidence
  readonly marketData: CandidateDevelopmentMarketDataWitness
}

export interface CandidateDevelopmentCommandEffects<Registration, DevelopmentData, Error, Requirements> extends Omit<
  CandidateDevelopmentEffects<Registration, DevelopmentData, Error, Requirements>,
  'evaluateDevelopment'
> {
  readonly evaluateDevelopment: (
    data: DevelopmentData,
    preflight: CandidateDevelopmentPreflightPass,
    verifiedSource: CandidateDevelopmentVerifiedSource,
  ) => Effect.Effect<CandidateDevelopmentCommandEvaluation, Error, Requirements>
}

export interface CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements> {
  readonly schemaVersion: typeof candidateDevelopmentExecutableProgramSchemaVersion
  readonly input: CandidateDevelopmentPreflightInput
  readonly strategyProtocol: CandidateDevelopmentStrategyProtocol
  readonly effects: CandidateDevelopmentCommandEffects<Registration, DevelopmentData, Error, Requirements>
}

export interface CandidateDevelopmentCommandReportMaterial {
  readonly schemaVersion: 'bayn.candidate-development-command-report.v6'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
  readonly strategyProtocol: CandidateDevelopmentStrategyProtocol
  readonly officialSessions: CandidateDevelopmentPreflightInput['officialSessions']
  readonly marketData: CandidateDevelopmentMarketDataWitness
  readonly verifiedSource: CandidateDevelopmentVerifiedSource
  readonly decision: CandidateDevelopmentCommandDecision
  readonly baseline: EvaluationResult
  readonly accounting: CandidateDevelopmentAccountingEvidence
  readonly development: CandidateDevelopmentReport
}

export interface CandidateDevelopmentCommandReport extends CandidateDevelopmentCommandReportMaterial {
  readonly contentHash: string
}

export type CandidateDevelopmentCommandFailure =
  | CandidateDevelopmentRunFailure
  | {
      readonly _tag: 'CandidateDevelopmentCommandHashFailed'
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandModulePathMissing'
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandSourceManifestPathMissing'
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandSourceVerificationFailed'
      readonly operation:
        | 'resolve-repository'
        | 'read-module'
        | 'read-source-manifest'
        | 'decode-preregistration'
        | 'decode-source-manifest'
        | 'verify-source-paths'
        | 'verify-head'
        | 'verify-module-blob'
        | 'verify-module-format'
        | 'verify-preregistration-blob'
        | 'verify-preregistration-lineage'
        | 'verify-preregistration-module-novelty'
        | 'verify-repository-integrity'
        | 'verify-source-manifest-blob'
        | 'verify-program-binding'
        | 'verify-runtime-market-data'
        | 'verify-attempt-authorization'
        | 'derive-run-identity'
        | 'verify-post-import'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandModuleLoadFailed'
      readonly modulePath: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandProgramInvalid'
      readonly reason:
        | 'module-export-missing'
        | 'schema-version-mismatch'
        | 'input-missing'
        | 'input-invalid'
        | 'strategy-protocol-missing'
        | 'strategy-protocol-invalid'
        | 'strategy-protocol-hash-mismatch'
        | 'effects-missing'
        | 'effect-function-missing'
        | 'evaluation-invalid'
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandEvaluationMissing'
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandProgramExecutionFailed'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandOutputFailed'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid'
      readonly series:
        | 'strategy'
        | 'buy-and-hold'
        | 'direct-volatility-timing'
        | 'double-cost-series'
        | 'double-cost-stressed'
      readonly reason:
        | 'observations-insufficient'
        | 'micros-invalid'
        | 'cumulative-mismatch'
        | 'return-mismatch'
        | 'session-mismatch'
        | 'metrics-failed'
        | 'metrics-mismatch'
      readonly index: number | null
      readonly field: string | null
      readonly expected: unknown
      readonly observed: unknown
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid'
      readonly reason: 'binding-mismatch' | 'reconstruction-failed' | 'proof-mismatch' | 'selected-trace-mismatch'
      readonly index: number | null
      readonly field: string
      readonly expected: unknown
      readonly observed: unknown
      readonly cause?: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandEconomicGateSetInvalid'
      readonly expectedGateNames: readonly string[]
      readonly observedGateNames: readonly string[]
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandEconomicGateInvalid'
      readonly index: number
      readonly expected: EvaluationResult['verdict']['gates'][number]
      readonly observed: EvaluationResult['verdict']['gates'][number]
    }
  | {
      readonly _tag: 'CandidateDevelopmentCommandEconomicVerdictInvalid'
      readonly expectedStatus: EvaluationResult['verdict']['status']
      readonly observedStatus: EvaluationResult['verdict']['status']
      readonly failedGateNames: readonly string[]
    }

export const CandidateDevelopmentPreflightInputSchema = Schema.Struct({
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  expectedStrategyProtocolHash: Sha256Schema,
  officialSessions: Schema.Array(IsoDateSchema),
  signalSessionDates: Schema.Array(IsoDateSchema),
  featureLookbackSessions: NonNegativeIntegerSchema,
})

const CandidateDevelopmentSimulatedOrderSchema = Schema.Struct({
  id: Sha256Schema,
  decisionId: Sha256Schema,
  sessionDate: IsoDateSchema,
  symbol: Schema.String,
  side: Schema.Literals(['buy', 'sell']),
  requestedQuantityMicros: DigitsSchema,
  filledQuantityMicros: DigitsSchema,
  status: Schema.Literals(['filled', 'partially-filled', 'rejected']),
  rejectionReason: Schema.NullOr(
    Schema.Literals(['below-minimum-buy-notional', 'zero-after-rounding', 'insufficient-buying-power']),
  ),
  unfilledRemainder: Schema.Literals(['none', 'canceled']),
})

const CandidateDevelopmentCashChangeSchema = Schema.Struct({
  id: Sha256Schema,
  sourceKind: Schema.Literals(['fill', 'fee', 'cash-yield']),
  sourceId: Sha256Schema,
  sessionDate: IsoDateSchema,
  amountMicros: SignedMicrosSchema,
  cashAfterMicros: SignedMicrosSchema,
})

const CandidateDevelopmentSimulationTraceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.simulation-trace.v3'),
  executionModel: ExecutionModelSchema,
  costMultiplierMicros: DigitsSchema,
  orders: Schema.Array(CandidateDevelopmentSimulatedOrderSchema),
  cashChanges: Schema.Array(CandidateDevelopmentCashChangeSchema),
  dailyMarks: DailyPositionMarksArtifactSchema.fields.items,
})

const CandidateDevelopmentEvaluationResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.evaluation.v6'),
  runId: Sha256Schema,
  codeRevision: SourceRevisionSchema,
  protocolHash: Sha256Schema,
  initialCapitalMicros: DigitsSchema,
  inputManifest: InputManifestArtifactSchema,
  strategy: EvaluationSummarySchema.fields.strategy,
  buyAndHold: EvaluationSummarySchema.fields.buyAndHold,
  directVolTiming: EvaluationSummarySchema.fields.directVolTiming,
  doubleCostStrategy: EvaluationSummarySchema.fields.doubleCostStrategy,
  verdict: EvaluationSummarySchema.fields.verdict,
  events: EvaluationEventsSchema,
  simulation: CandidateDevelopmentSimulationTraceSchema,
  benchmarkSeries: Schema.Struct({
    buyAndHold: DailyPerformanceSeriesArtifactSchema.fields.items,
    directVolTiming: DailyPerformanceSeriesArtifactSchema.fields.items,
    doubleCostStrategy: DailyPerformanceSeriesArtifactSchema.fields.items,
  }),
  equitySeries: EquitySeriesArtifactSchema.fields.items,
  markedEquityReconciliation: MarkedEquityReconciliationSchema,
  signalDecisions: RiskBalancedTrendSignalDecisionsArtifactSchema.fields.items,
})

const CandidateDevelopmentAccountingEvidenceSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-accounting-evidence.v2'),
  runId: Sha256Schema,
  initialCapitalMicros: DigitsSchema,
  evaluatorTotalFeesMicros: DigitsSchema,
  evaluatorEndingEquityMicros: DigitsSchema,
  events: EvaluationEventsSchema,
  baselineSimulation: CandidateDevelopmentSimulationTraceSchema,
  equitySeries: EquitySeriesArtifactSchema.fields.items,
  markedEquityReconciliation: MarkedEquityReconciliationSchema,
  signalDecisions: RiskBalancedTrendSignalDecisionsArtifactSchema.fields.items,
  stressedRunId: Sha256Schema,
  stressedEvaluatorTotalFeesMicros: DigitsSchema,
  stressedEvaluatorEndingEquityMicros: DigitsSchema,
  stressedEvents: EvaluationEventsSchema,
  stressedSimulation: CandidateDevelopmentSimulationTraceSchema,
  stressedEquitySeries: EquitySeriesArtifactSchema.fields.items,
  stressedMarkedEquityReconciliation: MarkedEquityReconciliationSchema,
})

const CandidateDevelopmentDailyBarBase = Schema.Struct({
  symbol: SymbolSchema,
  sessionDate: IsoDateSchema,
  open: PositiveFiniteSchema,
  high: PositiveFiniteSchema,
  low: PositiveFiniteSchema,
  close: PositiveFiniteSchema,
  volume: NonNegativeFiniteSchema,
  source: Schema.Enum(DataSource),
  sourceFeed: Schema.Enum(DataFeed),
  adjustment: Schema.Enum(PriceAdjustment),
  publicationSchemaVersion: Schema.Enum(PublicationSchema),
})

const CandidateDevelopmentDailyBarSchema = CandidateDevelopmentDailyBarBase.check(
  Schema.makeFilter((bar): readonly Schema.FilterIssue[] =>
    bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close) && bar.low <= bar.high
      ? []
      : [
          {
            path: ['low'],
            issue: 'must satisfy low <= min(open, close) <= max(open, close) <= high',
          },
        ],
  ),
)

const CandidateDevelopmentMarketDataWitnessSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-market-data-witness.v1'),
  snapshotId: Sha256Schema,
  inputManifestHash: Sha256Schema,
  contentHash: Sha256Schema,
  bars: Schema.Array(CandidateDevelopmentDailyBarSchema).check(Schema.isMinLength(1)),
})

const CandidateDevelopmentPlannedDecisionSchema = Schema.Struct({
  ...DecisionPlanSchema.fields,
  executionDate: IsoDateSchema,
})

const CandidateDevelopmentStrategyPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-strategy-plan.v1'),
  decisions: Schema.Array(CandidateDevelopmentPlannedDecisionSchema).check(Schema.isMinLength(1)),
})

const CandidateDevelopmentMomentumStrategyIdentitySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-strategy-identity.v1'),
  family: Schema.String.check(Schema.isMinLength(1)),
  identifier: Schema.String.check(Schema.isMinLength(1)),
  researchSources: Schema.Tuple([StrictNonEmptyStringSchema, StrictNonEmptyStringSchema, StrictNonEmptyStringSchema]),
  parameters: Schema.Struct({
    id: StrictNonEmptyStringSchema,
    lookbackSessions: PositiveIntegerSchema,
    volatilityWindowSessions: PositiveIntegerSchema,
    annualizationSessions: PositiveIntegerSchema,
    riskAssets: Schema.Tuple([SymbolSchema, SymbolSchema]),
    defensiveAsset: SymbolSchema,
    absoluteMomentumThreshold: Schema.Finite,
    selectedAssetWeight: UnitIntervalSchema,
    relativeMomentumTieBreak: SymbolSchema,
  }),
  input: StrictNonEmptyStringSchema,
  relativeMomentum: StrictNonEmptyStringSchema,
  absoluteMomentum: StrictNonEmptyStringSchema,
  defensive: StrictNonEmptyStringSchema,
  allocation: StrictNonEmptyStringSchema,
  schedule: StrictNonEmptyStringSchema,
  terminal: StrictNonEmptyStringSchema,
  missingData: StrictNonEmptyStringSchema,
  doubledCost: StrictNonEmptyStringSchema,
})

const CandidateDevelopmentInverseVolatilityStrategyIdentitySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-strategy-identity.v2'),
  family: Schema.Literal('inverse-volatility-risk-diversification'),
  identifier: StrictNonEmptyStringSchema,
  researchSources: Schema.Tuple([StrictNonEmptyStringSchema, StrictNonEmptyStringSchema, StrictNonEmptyStringSchema]),
  parameters: Schema.Struct({
    id: StrictNonEmptyStringSchema,
    lookbackSessions: PositiveIntegerSchema,
    annualizationSessions: PositiveIntegerSchema,
    riskAssets: Schema.Tuple([SymbolSchema, SymbolSchema]),
    covarianceEstimator: Schema.Literal('sample'),
    targetAnnualizedVolatility: PositiveFiniteSchema,
    maximumGrossExposure: UnitIntervalSchema,
  }),
  input: StrictNonEmptyStringSchema,
  weighting: StrictNonEmptyStringSchema,
  riskScaling: StrictNonEmptyStringSchema,
  allocation: StrictNonEmptyStringSchema,
  schedule: StrictNonEmptyStringSchema,
  terminal: StrictNonEmptyStringSchema,
  missingData: StrictNonEmptyStringSchema,
  doubledCost: StrictNonEmptyStringSchema,
})

const CandidateDevelopmentStrategyIdentitySchema = Schema.Union([
  CandidateDevelopmentMomentumStrategyIdentitySchema,
  CandidateDevelopmentInverseVolatilityStrategyIdentitySchema,
])

export const CandidateDevelopmentStrategyProtocolSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-strategy-protocol.v2'),
  universe: Schema.Array(SymbolSchema).check(Schema.isMinLength(1)),
  directVolatilityTarget: PositiveFiniteSchema,
  initialCapitalMicros: PositiveMicrosSchema,
  executionModel: ExecutionModelSchema,
  thresholds: Schema.Struct({
    minimumObservations: PositiveIntegerSchema,
    minimumAnnualizedReturn: Schema.Finite.check(Schema.isGreaterThan(-1)),
    minimumSharpeImprovement: Schema.Finite,
    maximumDrawdown: UnitIntervalSchema,
    maximumAnnualTurnover: PositiveFiniteSchema,
    requirePositiveDoubleCostReturn: Schema.Boolean,
  }),
  marketData: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-market-data-contract.v1'),
    snapshotId: Sha256Schema,
    contentHash: Sha256Schema,
  }),
  benchmarks: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-benchmark-policy.v1'),
    symbol: SymbolSchema,
    directVolatilityWindow: Schema.Literal(DIRECT_VOLATILITY_WINDOW),
    terminalPolicy: Schema.Literal('last-all-cash-strategy-decision'),
  }),
  strategyIdentity: Schema.optionalKey(CandidateDevelopmentStrategyIdentitySchema),
})

export const CandidateDevelopmentSourceManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-source-manifest.v1'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  strategyProtocolHash: Sha256Schema,
  strategyIdentityHash: Schema.optionalKey(Sha256Schema),
  candidateDevelopmentProtocolHash: Schema.optionalKey(Sha256Schema),
  calendarHash: Schema.optionalKey(Sha256Schema),
  priorTrialsHash: Schema.optionalKey(Sha256Schema),
  modulePath: Schema.String.check(Schema.isMinLength(1)),
  moduleSha256: Schema.optionalKey(Sha256Schema),
  moduleFormat: Schema.Literal('self-contained-esm-v1'),
  marketData: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-market-data-source.v1'),
    snapshotId: Sha256Schema,
    finalizedSnapshotContentHash: Sha256Schema,
    inputManifestHash: Sha256Schema,
    boundedContentHash: Sha256Schema,
  }),
})

export const CandidateDevelopmentArtifactStructuralBindingsSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-artifact-structural-bindings.v1'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  strategyProtocolHash: Sha256Schema,
  strategyIdentityHash: Sha256Schema,
  candidateDevelopmentProtocolHash: Sha256Schema,
  calendarHash: Sha256Schema,
  priorTrialsHash: Sha256Schema,
  modulePath: StrictNonEmptyStringSchema,
  sourceManifestPath: StrictNonEmptyStringSchema,
})

const CandidateDevelopmentPreregistrationDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.candidate-development-next-preregistration.v1'),
  candidateOrdinal: PositiveIntegerSchema,
  priorTrialCount: NonNegativeIntegerSchema,
  strategyProtocolHash: Sha256Schema,
  strategyIdentityHash: Schema.optionalKey(Sha256Schema),
  candidateDevelopmentProtocolHash: Schema.optionalKey(Sha256Schema),
  calendarHash: Schema.optionalKey(Sha256Schema),
  priorTrialsHash: Schema.optionalKey(Sha256Schema),
  modulePath: Schema.String,
  moduleSha256: Sha256Schema,
  marketData: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.candidate-development-market-data-source.v1'),
    snapshotId: Sha256Schema,
    finalizedSnapshotContentHash: Sha256Schema,
    inputManifestHash: Sha256Schema,
    boundedContentHash: Sha256Schema,
  }),
})

const CandidateDevelopmentComparisonSemanticsEvidenceBoundarySchema = Schema.Struct({
  schemaVersion: Schema.Literal(candidateDevelopmentComparisonSemantics.evidence.schemaVersion),
  candidateDevelopmentProtocolHash: Sha256Schema,
  strategyProtocolHash: Sha256Schema,
  comparisonSemantics: Schema.Unknown,
  analysis: Schema.Unknown,
})

const CandidateDevelopmentDoubledCostRunSchema = Schema.Struct({
  signalDecisions: RiskBalancedTrendSignalDecisionsArtifactSchema.fields.items,
  simulation: CandidateDevelopmentSimulationTraceSchema,
})

export const CandidateDevelopmentEvaluationSchema = Schema.Struct({
  baseline: CandidateDevelopmentEvaluationResultSchema,
  comparisonSemantics: CandidateDevelopmentComparisonSemanticsEvidenceBoundarySchema,
  stressed: CandidateDevelopmentDoubledCostRunSchema,
  accounting: CandidateDevelopmentAccountingEvidenceSchema,
  marketData: CandidateDevelopmentMarketDataWitnessSchema,
})

export const decodeCandidateDevelopmentPreflightInput = Schema.decodeUnknownResult(
  CandidateDevelopmentPreflightInputSchema,
  strictParseOptions,
)

export const decodeCandidateDevelopmentEvaluation = Schema.decodeUnknownResult(
  CandidateDevelopmentEvaluationSchema,
  strictParseOptions,
)

export const decodeCandidateDevelopmentMarketDataWitness = Schema.decodeUnknownResult(
  CandidateDevelopmentMarketDataWitnessSchema,
  strictParseOptions,
)

export const decodeCandidateDevelopmentStrategyPlan = Schema.decodeUnknownResult(
  CandidateDevelopmentStrategyPlanSchema,
  strictParseOptions,
)

export const decodeCandidateDevelopmentInputManifest = Schema.decodeUnknownResult(
  InputManifestArtifactSchema,
  strictParseOptions,
)

export const decodeCandidateDevelopmentStrategyProtocol = Schema.decodeUnknownResult(
  CandidateDevelopmentStrategyProtocolSchema,
  strictParseOptions,
)

export const decodeCandidateDevelopmentSourceManifest = Schema.decodeUnknownResult(
  CandidateDevelopmentSourceManifestSchema,
  strictParseOptions,
)

export const decodeCandidateDevelopmentArtifactStructuralBindings = Schema.decodeUnknownResult(
  CandidateDevelopmentArtifactStructuralBindingsSchema,
  strictParseOptions,
)

export const decodeCandidateDevelopmentPreregistrationDocument = Schema.decodeUnknownResult(
  CandidateDevelopmentPreregistrationDocumentSchema,
  strictParseOptions,
)
