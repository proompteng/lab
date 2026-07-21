import { Schema } from 'effect'

import { EvaluationBoundsSchema, FinalizedSnapshotProvenanceSchema, IsoDateSchema, Sha256Schema } from './contracts'
import { canonicalHashV1 } from './hash'
import { ExecutionModelSchema } from './protocol'
import { MARKED_EQUITY_TOLERANCE_MICROS } from './simulation-reconciliation'

const StrictParseOptions = { onExcessProperty: 'error' } as const
const Micros = Schema.String.check(Schema.isPattern(/^\d+$/))
const SignedMicros = Schema.String.check(Schema.isPattern(/^-?\d+$/))
const SourceRevision = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const UnitIntervalFinite = NonNegativeFinite.check(Schema.isLessThanOrEqualTo(1))
const Scalar = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String])
const Symbol = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,15}$/))

const InputManifestBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.input-manifest.v2'),
  hash: Sha256Schema,
  database: Schema.Literal('signal'),
  tables: Schema.Struct({
    bars: Schema.Literal('adjusted_daily_bars_v2'),
    sessions: Schema.Literal('exchange_sessions_v1'),
    manifests: Schema.Literal('snapshot_manifests_v1'),
  }),
  finalizedSnapshot: FinalizedSnapshotProvenanceSchema,
  bounds: EvaluationBoundsSchema,
  rowCount: PositiveInteger,
  sessionCount: PositiveInteger,
  firstSession: IsoDateSchema,
  lastSession: IsoDateSchema,
  symbols: Schema.Array(
    Schema.Struct({
      symbol: Symbol,
      rows: PositiveInteger,
      firstSession: IsoDateSchema,
      lastSession: IsoDateSchema,
    }),
  ).check(Schema.isMinLength(1)),
})

export const InputManifestArtifactSchema = InputManifestBase.check(
  Schema.makeFilter((manifest: typeof InputManifestBase.Type) => {
    const { hash, ...material } = manifest
    const symbolNames = manifest.symbols.map((coverage) => coverage.symbol)
    const issues: Schema.FilterIssue[] = []
    if (canonicalHashV1(material) !== hash) issues.push({ path: ['hash'], issue: 'does not match the manifest' })
    if (manifest.firstSession !== manifest.bounds.dataStart) {
      issues.push({ path: ['firstSession'], issue: 'must equal bounds.dataStart' })
    }
    if (manifest.lastSession !== manifest.bounds.dataEnd) {
      issues.push({ path: ['lastSession'], issue: 'must equal bounds.dataEnd' })
    }
    if (manifest.rowCount !== manifest.sessionCount * manifest.symbols.length) {
      issues.push({ path: ['rowCount'], issue: 'must equal sessionCount multiplied by symbol count' })
    }
    if (canonicalHashV1(symbolNames) !== canonicalHashV1(manifest.finalizedSnapshot.symbols)) {
      issues.push({ path: ['symbols'], issue: 'must match the finalized snapshot universe' })
    }
    for (const [index, coverage] of manifest.symbols.entries()) {
      if (
        coverage.rows !== manifest.sessionCount ||
        coverage.firstSession !== manifest.firstSession ||
        coverage.lastSession !== manifest.lastSession
      ) {
        issues.push({ path: ['symbols', index], issue: 'coverage does not match the bounded manifest' })
      }
    }
    return issues
  }),
)

const PerformanceMetricsSchema = Schema.Struct({
  observations: PositiveInteger,
  totalReturn: Schema.Finite,
  annualizedReturn: Schema.Finite,
  annualizedVolatility: Schema.Finite,
  sharpe: Schema.Finite,
  maximumDrawdown: Schema.Finite,
  annualTurnover: Schema.Finite,
  totalFeesMicros: Micros,
  totalSpreadCostMicros: Micros,
  totalSlippageCostMicros: Micros,
  totalCashYieldMicros: Micros,
  endingEquityMicros: Micros,
})

const VerdictSchema = Schema.Struct({
  status: Schema.Literals(['PASS', 'FAIL_CLOSED']),
  gates: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      passed: Schema.Boolean,
      actual: Scalar,
      required: Scalar,
    }),
  ),
})

export const MarkedEquityReconciliationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.marked-equity-reconciliation.v2'),
  runId: Sha256Schema,
  toleranceMicros: Schema.Literal(MARKED_EQUITY_TOLERANCE_MICROS.toString()),
  maximumDailyDifferenceMicros: Micros,
  reconstructedCashMicros: Schema.String.check(Schema.isPattern(/^-?\d+$/)),
  reconstructedPositionValueMicros: Micros,
  evaluatorTotalFeesMicros: Micros,
  reconstructedTotalFeesMicros: Micros,
  feeDifferenceMicros: Micros,
  evaluatorEndingEquityMicros: Micros,
  reconstructedEndingEquityMicros: Micros,
  differenceMicros: Micros,
  exact: Schema.Boolean,
  withinTolerance: Schema.Literal(true),
})

const EvaluationSummaryFields = {
  runId: Sha256Schema,
  codeRevision: SourceRevision,
  protocolHash: Sha256Schema,
  initialCapitalMicros: Micros,
  input: Schema.Struct({
    snapshotId: Sha256Schema,
    publicationId: Sha256Schema,
    manifestHash: Sha256Schema,
    bounds: EvaluationBoundsSchema,
    rowCount: PositiveInteger,
    sessionCount: PositiveInteger,
    symbols: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  }),
  strategy: PerformanceMetricsSchema,
  buyAndHold: PerformanceMetricsSchema,
  directVolTiming: PerformanceMetricsSchema,
  doubleCostStrategy: PerformanceMetricsSchema,
  verdict: VerdictSchema,
  eventCount: PositiveInteger,
  signalDecisionCount: PositiveInteger,
  orderCount: PositiveInteger,
  cashChangeCount: PositiveInteger,
  dailyMarkCount: PositiveInteger,
  benchmarkSeriesCounts: Schema.Struct({
    buyAndHold: PositiveInteger,
    directVolTiming: PositiveInteger,
    doubleCostStrategy: PositiveInteger,
  }),
  markedEquityReconciliation: MarkedEquityReconciliationSchema,
} as const

export const EvaluationSummarySchema = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.evaluation-summary.v3'),
    evaluationSchemaVersion: Schema.Literal('bayn.evaluation.v4'),
    ...EvaluationSummaryFields,
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.evaluation-summary.v4'),
    evaluationSchemaVersion: Schema.Literal('bayn.evaluation.v5'),
    ...EvaluationSummaryFields,
  }),
])

export const ReconciliationResultSchema = Schema.Struct({
  runId: Sha256Schema,
  accountCount: PositiveInteger,
  transferCount: PositiveInteger,
  exact: Schema.Literal(true),
})

const DecisionEventSchema = Schema.Struct({
  kind: Schema.Literal('decision'),
  id: Sha256Schema,
  signalDate: IsoDateSchema,
  executionDate: IsoDateSchema,
  targetWeights: Schema.Record(Schema.String, Schema.Finite),
})

const FillEventSchema = Schema.Struct({
  kind: Schema.Literal('fill'),
  id: Sha256Schema,
  orderId: Sha256Schema,
  decisionId: Sha256Schema,
  sessionDate: IsoDateSchema,
  symbol: Schema.String,
  side: Schema.Literals(['buy', 'sell']),
  quantityMicros: Micros,
  referencePriceMicros: Micros,
  priceMicros: Micros,
  notionalMicros: Micros,
  spreadCostMicros: Micros,
  slippageCostMicros: Micros,
  costBasisMicros: Micros,
})

const FeeEventSchema = Schema.Struct({
  kind: Schema.Literal('fee'),
  id: Sha256Schema,
  sessionDate: IsoDateSchema,
  commissionMicros: Micros,
  secMicros: Micros,
  tafMicros: Micros,
  catMicros: Micros,
  totalMicros: Micros,
})

const CashYieldEventSchema = Schema.Struct({
  kind: Schema.Literal('cash-yield'),
  id: Sha256Schema,
  sessionDate: IsoDateSchema,
  elapsedDays: PositiveInteger,
  annualYieldBps: Schema.Finite,
  amountMicros: Micros,
})

export const EvaluationEventsSchema = Schema.Array(
  Schema.Union([DecisionEventSchema, FillEventSchema, FeeEventSchema, CashYieldEventSchema]),
)

export const SimulatedOrdersArtifactSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.simulated-orders.v2'),
  executionModel: ExecutionModelSchema,
  costMultiplierMicros: Micros,
  items: Schema.Array(
    Schema.Struct({
      id: Sha256Schema,
      decisionId: Sha256Schema,
      sessionDate: IsoDateSchema,
      symbol: Schema.String,
      side: Schema.Literals(['buy', 'sell']),
      requestedQuantityMicros: Micros,
      filledQuantityMicros: Micros,
      status: Schema.Literals(['filled', 'partially-filled', 'rejected']),
      rejectionReason: Schema.NullOr(Schema.Literals(['below-minimum-buy-notional', 'zero-after-rounding'])),
      unfilledRemainder: Schema.Literals(['none', 'canceled']),
    }),
  ).check(Schema.isMinLength(1)),
})

export const CashChangesArtifactSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.cash-changes.v2'),
  items: Schema.Array(
    Schema.Struct({
      id: Sha256Schema,
      sourceKind: Schema.Literals(['fill', 'fee', 'cash-yield']),
      sourceId: Sha256Schema,
      sessionDate: IsoDateSchema,
      amountMicros: SignedMicros,
      cashAfterMicros: SignedMicros,
    }),
  ).check(Schema.isMinLength(1)),
})

const DailyPerformanceFields = {
  sessionDate: IsoDateSchema,
  equityMicros: Micros,
  netReturn: Schema.Finite,
  turnoverMicros: Micros,
  cumulativeTurnoverMicros: Micros,
  feeMicros: Micros,
  cumulativeFeesMicros: Micros,
  spreadCostMicros: Micros,
  cumulativeSpreadCostMicros: Micros,
  slippageCostMicros: Micros,
  cumulativeSlippageCostMicros: Micros,
  cashYieldMicros: Micros,
  cumulativeCashYieldMicros: Micros,
  peakEquityMicros: Micros,
  drawdown: Schema.Finite,
} as const

const DailyPerformancePointSchema = Schema.Struct(DailyPerformanceFields)

export const DailyPositionMarksArtifactSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.daily-position-marks.v3'),
  items: Schema.Array(
    Schema.Struct({
      ...DailyPerformanceFields,
      cashMicros: Micros,
      positions: Schema.Array(
        Schema.Struct({
          symbol: Schema.String,
          quantityMicros: Micros,
          costBasisMicros: Micros,
          priceMicros: Micros,
          marketValueMicros: Micros,
        }),
      ).check(Schema.isMinLength(1)),
    }),
  ).check(Schema.isMinLength(1)),
})

export const TsmomSignalDecisionsArtifactSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.tsmom-signal-decisions.v1'),
  items: Schema.Array(
    Schema.Struct({
      schemaVersion: Schema.Literal('bayn.tsmom-decision-plan.v1'),
      decisionId: Sha256Schema,
      signalDate: IsoDateSchema,
      executionDate: IsoDateSchema,
      targetWeights: Schema.Record(Symbol, Schema.Finite),
      signals: Schema.Array(
        Schema.Struct({
          symbol: Symbol,
          lookbacks: Schema.Array(
            Schema.Struct({
              lookbackSessions: PositiveInteger,
              return: Schema.Finite,
              direction: Schema.Literals(['positive', 'non-positive']),
            }),
          ).check(Schema.isMinLength(1)),
          score: Schema.Int,
          active: Schema.Boolean,
          targetWeight: Schema.Finite,
        }),
      ).check(Schema.isMinLength(1)),
    }),
  ).check(Schema.isMinLength(1)),
})

export const RiskBalancedTrendSignalDecisionsArtifactSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.risk-balanced-trend-decisions.v1'),
  items: Schema.Array(
    Schema.Struct({
      schemaVersion: Schema.Literal('bayn.risk-balanced-trend-decision-plan.v1'),
      decisionId: Sha256Schema,
      signalDate: IsoDateSchema,
      executionDate: IsoDateSchema,
      covarianceWindow: Schema.Struct({
        returnCount: PositiveInteger,
        firstSession: IsoDateSchema,
        lastSession: IsoDateSchema,
        sessionsHash: Sha256Schema,
      }),
      estimatedAnnualizedPortfolioVolatility: NonNegativeFinite,
      exposureScale: UnitIntervalFinite,
      targetWeights: Schema.Record(Symbol, UnitIntervalFinite),
      signals: Schema.Array(
        Schema.Struct({
          symbol: Symbol,
          horizons: Schema.Array(
            Schema.Struct({
              horizonSessions: PositiveInteger,
              return: Schema.Finite,
              normalizedTrend: Schema.Finite,
            }),
          ).check(Schema.isMinLength(1)),
          dailyVolatility: NonNegativeFinite,
          annualizedVolatility: NonNegativeFinite,
          compositeScore: Schema.Finite,
          positiveScore: NonNegativeFinite,
          eligible: Schema.Boolean,
          uncappedWeight: UnitIntervalFinite,
          cappedWeight: UnitIntervalFinite,
          targetWeight: UnitIntervalFinite,
        }),
      ).check(Schema.isMinLength(1)),
    }),
  ).check(Schema.isMinLength(1)),
})

export const DailyPerformanceSeriesArtifactSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.daily-performance-series.v1'),
  series: Schema.Literals(['buy-and-hold', 'direct-volatility-timing', 'double-cost-strategy']),
  items: Schema.Array(DailyPerformancePointSchema).check(Schema.isMinLength(1)),
})

export const QualificationArtifactManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-artifact-manifest.v1'),
  identity: Schema.Struct({
    runId: Sha256Schema,
    evaluationSchemaVersion: Schema.Literals(['bayn.evaluation.v4', 'bayn.evaluation.v5']),
    protocolHash: Sha256Schema,
    sourceRevision: SourceRevision,
    image: Schema.Struct({ repository: Schema.String, digest: ImageDigest }),
    snapshotId: Sha256Schema,
    publicationId: Sha256Schema,
    inputManifestHash: Sha256Schema,
    bounds: EvaluationBoundsSchema,
    calendarVersion: Schema.String,
  }),
  execution: Schema.Struct({
    parameterSchemaVersion: Schema.String,
    parameterHash: Sha256Schema,
    simulationSchemaVersion: Schema.Literal('bayn.simulation-trace.v3'),
    executionModel: ExecutionModelSchema,
    costMultiplierMicros: Micros,
  }),
  artifacts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      schemaVersion: Schema.String,
      itemCount: NonNegativeInteger,
      contentHash: Sha256Schema,
    }),
  ).check(Schema.isMinLength(1)),
  events: Schema.Struct({ count: PositiveInteger, contentHash: Sha256Schema }),
  gates: Schema.Struct({ count: PositiveInteger, contentHash: Sha256Schema }),
})

export const EquitySeriesArtifactSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.equity-series.v1'),
  items: Schema.Array(
    Schema.Struct({
      sessionDate: IsoDateSchema,
      evaluatorEquityMicros: Micros,
      reconstructedEquityMicros: Micros,
      differenceMicros: Micros,
    }),
  ).check(Schema.isMinLength(1)),
})

export const decodeEvaluationSummary = Schema.decodeUnknownEffect(EvaluationSummarySchema, StrictParseOptions)
export const decodeReconciliationResult = Schema.decodeUnknownEffect(ReconciliationResultSchema, StrictParseOptions)
export const decodeMarkedEquityReconciliation = Schema.decodeUnknownEffect(
  MarkedEquityReconciliationSchema,
  StrictParseOptions,
)
export const decodeInputManifestArtifact = Schema.decodeUnknownEffect(InputManifestArtifactSchema, StrictParseOptions)
export const decodeEquitySeriesArtifact = Schema.decodeUnknownEffect(EquitySeriesArtifactSchema, StrictParseOptions)
export const decodeEvaluationEvents = Schema.decodeUnknownEffect(EvaluationEventsSchema, StrictParseOptions)
export const decodeSimulatedOrdersArtifact = Schema.decodeUnknownEffect(
  SimulatedOrdersArtifactSchema,
  StrictParseOptions,
)
export const decodeCashChangesArtifact = Schema.decodeUnknownEffect(CashChangesArtifactSchema, StrictParseOptions)
export const decodeDailyPositionMarksArtifact = Schema.decodeUnknownEffect(
  DailyPositionMarksArtifactSchema,
  StrictParseOptions,
)
export const decodeTsmomSignalDecisionsArtifact = Schema.decodeUnknownEffect(
  TsmomSignalDecisionsArtifactSchema,
  StrictParseOptions,
)
export const decodeRiskBalancedTrendSignalDecisionsArtifact = Schema.decodeUnknownEffect(
  RiskBalancedTrendSignalDecisionsArtifactSchema,
  StrictParseOptions,
)
export const decodeDailyPerformanceSeriesArtifact = Schema.decodeUnknownEffect(
  DailyPerformanceSeriesArtifactSchema,
  StrictParseOptions,
)
export const decodeQualificationArtifactManifest = Schema.decodeUnknownEffect(
  QualificationArtifactManifestSchema,
  StrictParseOptions,
)

export const makeEquitySeriesArtifact = (items: (typeof EquitySeriesArtifactSchema.Type)['items']) => ({
  schemaVersion: 'bayn.equity-series.v1' as const,
  items,
})
