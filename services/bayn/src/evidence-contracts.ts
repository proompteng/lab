import { Schema } from 'effect'

import { EvaluationBoundsSchema, FinalizedSnapshotProvenanceSchema, IsoDateSchema, Sha256Schema } from './contracts'
import { canonicalHashV1 } from './hash'
import { MARKED_EQUITY_TOLERANCE_MICROS } from './simulation-reconciliation'

const StrictParseOptions = { onExcessProperty: 'error' } as const
const Micros = Schema.String.check(Schema.isPattern(/^\d+$/))
const SignedMicros = Schema.String.check(Schema.isPattern(/^-?\d+$/))
const SourceRevision = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
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
  schemaVersion: Schema.Literal('bayn.marked-equity-reconciliation.v1'),
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

export const EvaluationSummarySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.evaluation-summary.v1'),
  runId: Sha256Schema,
  evaluationSchemaVersion: Schema.Literal('bayn.evaluation.v2'),
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
  orderCount: PositiveInteger,
  cashChangeCount: PositiveInteger,
  dailyMarkCount: PositiveInteger,
  markedEquityReconciliation: MarkedEquityReconciliationSchema,
})

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
  priceMicros: Micros,
  notionalMicros: Micros,
  feeMicros: Micros,
  costBasisMicros: Micros,
})

export const EvaluationEventsSchema = Schema.Array(Schema.Union([DecisionEventSchema, FillEventSchema]))

export const SimulatedOrdersArtifactSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.simulated-orders.v1'),
  transactionCostBpsMicros: Micros,
  items: Schema.Array(
    Schema.Struct({
      id: Sha256Schema,
      decisionId: Sha256Schema,
      sessionDate: IsoDateSchema,
      symbol: Schema.String,
      side: Schema.Literals(['buy', 'sell']),
      requestedQuantityMicros: Micros,
      filledQuantityMicros: Micros,
    }),
  ).check(Schema.isMinLength(1)),
})

export const CashChangesArtifactSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.cash-changes.v1'),
  items: Schema.Array(
    Schema.Struct({
      id: Sha256Schema,
      fillId: Sha256Schema,
      sessionDate: IsoDateSchema,
      amountMicros: SignedMicros,
      cashAfterMicros: SignedMicros,
    }),
  ).check(Schema.isMinLength(1)),
})

export const DailyPositionMarksArtifactSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.daily-position-marks.v1'),
  items: Schema.Array(
    Schema.Struct({
      sessionDate: IsoDateSchema,
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
      equityMicros: Micros,
    }),
  ).check(Schema.isMinLength(1)),
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

export const makeEquitySeriesArtifact = (items: (typeof EquitySeriesArtifactSchema.Type)['items']) => ({
  schemaVersion: 'bayn.equity-series.v1' as const,
  items,
})
