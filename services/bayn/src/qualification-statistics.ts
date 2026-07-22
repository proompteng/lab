import { Schema } from 'effect'

import { IsoDateSchema, Sha256Schema } from './contracts'
import { canonicalHashV1 } from './hash'
import type { EvaluationResult, IsoDate } from './types'

const StrictParseOptions = { onExcessProperty: 'error' } as const
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0))
const UnitInterval = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const PositiveUnitInterval = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThan(1))
const SimpleReturn = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(-1))
const NonEmptyString = Schema.String.check(
  Schema.makeFilter((value: string) => value.length > 0 && value.trim() === value, {
    expected: 'a non-empty string without surrounding whitespace',
  }),
)
const Scalar = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String])

export const QualificationStatisticsPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-statistics-policy.v1'),
  annualizationSessions: Schema.Literal(252),
  confidence: Schema.Struct({
    familyOneSidedAlpha: Schema.Literal(0.05),
    multiplicityAdjustment: Schema.Literal('bonferroni'),
    minimumTailSamples: PositiveInteger,
  }),
  bootstrap: Schema.Struct({
    method: Schema.Literal('paired-complete-rebalance-blocks'),
    samples: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 100_000 })),
    seedNamespace: NonEmptyString,
    lowerQuantile: Schema.Literal('nearest-rank'),
  }),
  power: Schema.Struct({
    method: Schema.Literal('normal-approximation-independent-rebalance-blocks'),
    oneSidedAlpha: Schema.Literal(0.05),
    targetPower: Schema.Literal(0.8),
    minimumDetectableAnnualizedExcessReturn: PositiveFinite,
    assumedAnnualizedTrackingVolatility: PositiveFinite,
    assumedSessionsPerRebalanceBlock: PositiveInteger,
    absoluteMinimumSessions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(504)),
    absoluteMinimumRebalanceBlocks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(24)),
  }),
  walkForward: Schema.Struct({
    method: Schema.Literal('expanding-origin'),
    minimumTrainingSessions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(504)),
    testSessions: PositiveInteger,
    minimumFolds: PositiveInteger,
    minimumPositiveFoldFraction: PositiveUnitInterval,
    maximumFoldDrawdown: UnitInterval,
  }),
  cashReturn: Schema.Struct({
    method: Schema.Literal('actual-365-simple'),
  }),
})
export type QualificationStatisticsPolicy = typeof QualificationStatisticsPolicySchema.Type

export const defaultQualificationStatisticsPolicy: QualificationStatisticsPolicy = Schema.decodeUnknownSync(
  QualificationStatisticsPolicySchema,
  StrictParseOptions,
)({
  schemaVersion: 'bayn.qualification-statistics-policy.v1',
  annualizationSessions: 252,
  confidence: {
    familyOneSidedAlpha: 0.05,
    multiplicityAdjustment: 'bonferroni',
    minimumTailSamples: 20,
  },
  bootstrap: {
    method: 'paired-complete-rebalance-blocks',
    samples: 5_000,
    seedNamespace: 'bayn-risk-balanced-trend-qualification-v1',
    lowerQuantile: 'nearest-rank',
  },
  power: {
    method: 'normal-approximation-independent-rebalance-blocks',
    oneSidedAlpha: 0.05,
    targetPower: 0.8,
    minimumDetectableAnnualizedExcessReturn: 0.03,
    assumedAnnualizedTrackingVolatility: 0.1,
    assumedSessionsPerRebalanceBlock: 21,
    absoluteMinimumSessions: 504,
    absoluteMinimumRebalanceBlocks: 24,
  },
  walkForward: {
    method: 'expanding-origin',
    minimumTrainingSessions: 504,
    testSessions: 252,
    minimumFolds: 5,
    minimumPositiveFoldFraction: 0.6,
    maximumFoldDrawdown: 0.35,
  },
  cashReturn: { method: 'actual-365-simple' },
})

const QualificationObservationSchema = Schema.Struct({
  sessionDate: IsoDateSchema,
  strategyReturn: SimpleReturn,
  cashReturn: SimpleReturn,
  buyAndHoldReturn: SimpleReturn,
  directVolatilityReturn: SimpleReturn,
})
export type QualificationObservation = typeof QualificationObservationSchema.Type

const QualificationSeriesBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-series.v1'),
  runId: Sha256Schema,
  observations: Schema.Array(QualificationObservationSchema).check(Schema.isMinLength(2)),
  rebalanceExecutionDates: Schema.Array(IsoDateSchema).check(Schema.isMinLength(1)),
})

const canonicalDates = (path: string, values: readonly string[]): readonly Schema.FilterIssue[] => {
  const canonical = [...new Set(values)].sort()
  if (canonical.length !== values.length) return [{ path: [path], issue: 'must not contain duplicates' }]
  if (canonical.some((value, index) => value !== values[index])) {
    return [{ path: [path], issue: 'must be strictly increasing' }]
  }
  return []
}

export const QualificationSeriesSchema = QualificationSeriesBase.check(
  Schema.makeFilter((series: typeof QualificationSeriesBase.Type) => {
    const observationDates = series.observations.map((observation) => observation.sessionDate)
    const observed = new Set(observationDates)
    return [
      ...canonicalDates('observations', observationDates),
      ...canonicalDates('rebalanceExecutionDates', series.rebalanceExecutionDates),
      ...series.rebalanceExecutionDates.flatMap((date, index) =>
        observed.has(date)
          ? []
          : [{ path: ['rebalanceExecutionDates', index], issue: 'must identify an observed session' } as const],
      ),
    ]
  }),
)
export type QualificationSeries = typeof QualificationSeriesSchema.Type

const PowerAnalysisSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-power.v1'),
  method: Schema.Literal('normal-approximation-independent-rebalance-blocks'),
  oneSidedAlpha: Schema.Literal(0.05),
  targetPower: Schema.Literal(0.8),
  minimumDetectableAnnualizedExcessReturn: PositiveFinite,
  assumedAnnualizedTrackingVolatility: PositiveFinite,
  standardizedEffect: PositiveFinite,
  requiredCompleteRebalanceBlocks: PositiveInteger,
  requiredSessions: PositiveInteger,
  availableCompleteRebalanceBlocks: NonNegativeInteger,
  availableCompleteSessions: NonNegativeInteger,
  sufficient: Schema.Boolean,
})
export type PowerAnalysis = typeof PowerAnalysisSchema.Type

const CompleteBlockSchema = Schema.Struct({
  ordinal: NonNegativeInteger,
  startSession: IsoDateSchema,
  endSession: IsoDateSchema,
  nextRebalanceSession: IsoDateSchema,
  observationCount: PositiveInteger,
  contentHash: Sha256Schema,
})

const BootstrapAnalysisSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.paired-block-bootstrap.v1'),
  method: Schema.Literal('paired-complete-rebalance-blocks'),
  selectedBenchmark: Schema.Literals(['buy-and-hold', 'direct-volatility-timing']),
  selectedBenchmarkSharpe: Schema.Finite,
  seedHash: Sha256Schema,
  requestedSamples: PositiveInteger,
  producedSamples: NonNegativeInteger,
  adjustedOneSidedAlpha: PositiveUnitInterval,
  tailSampleCount: NonNegativeInteger,
  minimumTailSamples: PositiveInteger,
  tailResolutionSufficient: Schema.Boolean,
  annualizedExcessReturnLowerBound: Schema.Finite,
  sharpeDifferenceLowerBound: Schema.Finite,
  annualizedExcessReturnSamples: Schema.Array(Schema.Finite),
  sharpeDifferenceSamples: Schema.Array(Schema.Finite),
  samplesHash: Sha256Schema,
})

const WalkForwardFoldSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.walk-forward-fold.v1'),
  ordinal: NonNegativeInteger,
  trainingStart: IsoDateSchema,
  trainingEnd: IsoDateSchema,
  testStart: IsoDateSchema,
  testEnd: IsoDateSchema,
  testObservationCount: PositiveInteger,
  strategyReturn: Schema.Finite,
  cashReturn: Schema.Finite,
  excessReturn: Schema.Finite,
  maximumDrawdown: UnitInterval,
  positiveExcess: Schema.Boolean,
  drawdownWithinLimit: Schema.Boolean,
  contentHash: Sha256Schema,
})

const WalkForwardAnalysisSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.walk-forward.v1'),
  method: Schema.Literal('expanding-origin'),
  folds: Schema.Array(WalkForwardFoldSchema),
  requiredFolds: PositiveInteger,
  positiveFolds: NonNegativeInteger,
  positiveFoldFraction: UnitInterval,
  requiredPositiveFoldFraction: PositiveUnitInterval,
  allDrawdownsWithinLimit: Schema.Boolean,
  maximumFoldDrawdown: UnitInterval,
  sufficient: Schema.Boolean,
})

const QualificationGateSchema = Schema.Struct({
  name: NonEmptyString,
  passed: Schema.Boolean,
  actual: Scalar,
  required: Scalar,
})

const QualificationAnalysisMaterial = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.qualification-analysis.v1'),
  runId: Sha256Schema,
  policy: QualificationStatisticsPolicySchema,
  priorTrialRunIds: Schema.Array(Sha256Schema),
  candidateOrdinal: PositiveInteger,
  completeBlocks: Schema.Array(CompleteBlockSchema),
  power: PowerAnalysisSchema,
  bootstrap: BootstrapAnalysisSchema,
  walkForward: WalkForwardAnalysisSchema,
  gates: Schema.Array(QualificationGateSchema),
  status: Schema.Literals(['PASS', 'REJECTED', 'INSUFFICIENT']),
  reasonCodes: Schema.Array(NonEmptyString),
})

const QualificationAnalysisBase = Schema.Struct({
  ...QualificationAnalysisMaterial.fields,
  analysisHash: Sha256Schema,
})

export const QualificationAnalysisSchema = QualificationAnalysisBase.check(
  Schema.makeFilter((analysis: typeof QualificationAnalysisBase.Type) => {
    const { analysisHash, ...material } = analysis
    const issues = [...canonicalDates('priorTrialRunIds', analysis.priorTrialRunIds)]
    const bootstrapSamples = {
      schemaVersion: 'bayn.qualification-bootstrap-samples.v1',
      annualizedExcessReturnSamples: analysis.bootstrap.annualizedExcessReturnSamples,
      sharpeDifferenceSamples: analysis.bootstrap.sharpeDifferenceSamples,
    }
    if (analysis.candidateOrdinal !== analysis.priorTrialRunIds.length + 1) {
      issues.push({ path: ['candidateOrdinal'], issue: 'must follow every prior trial' })
    }
    if (
      analysis.bootstrap.producedSamples !== analysis.bootstrap.annualizedExcessReturnSamples.length ||
      analysis.bootstrap.producedSamples !== analysis.bootstrap.sharpeDifferenceSamples.length
    ) {
      issues.push({ path: ['bootstrap', 'producedSamples'], issue: 'must match both sample distributions' })
    }
    if (analysis.bootstrap.samplesHash !== canonicalHashV1(bootstrapSamples)) {
      issues.push({ path: ['bootstrap', 'samplesHash'], issue: 'must match the bootstrap sample distributions' })
    }
    if (
      analysis.completeBlocks.some(
        (block, index) =>
          block.ordinal !== index ||
          block.startSession > block.endSession ||
          block.endSession >= block.nextRebalanceSession,
      )
    ) {
      issues.push({ path: ['completeBlocks'], issue: 'must be ordinal and have increasing boundaries' })
    }
    if (
      analysis.walkForward.folds.some((fold, index) => {
        const { contentHash, ...foldMaterial } = fold
        return fold.ordinal !== index || contentHash !== canonicalHashV1(foldMaterial)
      })
    ) {
      issues.push({ path: ['walkForward', 'folds'], issue: 'must be ordinal and match their content hashes' })
    }
    const positiveFolds = analysis.walkForward.folds.filter((fold) => fold.positiveExcess).length
    const allDrawdownsWithinLimit = analysis.walkForward.folds.every((fold) => fold.drawdownWithinLimit)
    if (
      analysis.walkForward.positiveFolds !== positiveFolds ||
      analysis.walkForward.allDrawdownsWithinLimit !== allDrawdownsWithinLimit
    ) {
      issues.push({ path: ['walkForward'], issue: 'summary must match the fold evidence' })
    }
    if (analysisHash !== canonicalHashV1(material)) {
      issues.push({ path: ['analysisHash'], issue: 'must match the canonical analysis content hash' })
    }
    return issues
  }),
)
export type QualificationAnalysis = typeof QualificationAnalysisSchema.Type

interface BlockWork {
  readonly evidence: typeof CompleteBlockSchema.Type
  readonly observations: readonly QualificationObservation[]
}

const Z_ONE_SIDED_95 = 1.6448536269514722
const Z_POWER_80 = 0.8416212335729143

const roundStatistic = (value: number): number => {
  if (!Number.isFinite(value)) throw new TypeError('qualification statistic is not finite')
  return Number.parseFloat(value.toFixed(12))
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length

const sampleStandardDeviation = (values: readonly number[]): number => {
  if (values.length < 2) return 0
  const average = mean(values)
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  return Math.sqrt(Math.max(0, variance))
}

const sharpe = (returns: readonly number[], annualizationSessions: number): number => {
  const volatility = sampleStandardDeviation(returns)
  return volatility === 0 ? 0 : (mean(returns) / volatility) * Math.sqrt(annualizationSessions)
}

const daysBetween = (left: IsoDate, right: IsoDate): number => {
  const milliseconds = Date.parse(`${right}T00:00:00.000Z`) - Date.parse(`${left}T00:00:00.000Z`)
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new TypeError('qualification dates are not increasing')
  return Math.round(milliseconds / 86_400_000)
}

const dailyCashReturn = (annualYieldBps: number, elapsedDays: number): number =>
  (annualYieldBps / 10_000) * (elapsedDays / 365)

export const prepareQualificationSeries = (evaluation: EvaluationResult): QualificationSeries => {
  const buyAndHold = new Map(
    evaluation.benchmarkSeries.buyAndHold.map((point) => [point.sessionDate, point.netReturn] as const),
  )
  const directVolatility = new Map(
    evaluation.benchmarkSeries.directVolTiming.map((point) => [point.sessionDate, point.netReturn] as const),
  )
  if (
    buyAndHold.size !== evaluation.benchmarkSeries.buyAndHold.length ||
    directVolatility.size !== evaluation.benchmarkSeries.directVolTiming.length
  ) {
    throw new TypeError('qualification benchmark series contains duplicate dates')
  }

  let previousDate: IsoDate | null = null
  const observations = evaluation.simulation.dailyMarks.map((point) => {
    const buyAndHoldReturn = buyAndHold.get(point.sessionDate)
    const directVolatilityReturn = directVolatility.get(point.sessionDate)
    if (buyAndHoldReturn === undefined || directVolatilityReturn === undefined) {
      throw new TypeError(`qualification benchmark is missing ${point.sessionDate}`)
    }
    const elapsedDays = previousDate === null ? 1 : daysBetween(previousDate, point.sessionDate)
    previousDate = point.sessionDate
    return {
      sessionDate: point.sessionDate,
      strategyReturn: point.netReturn,
      cashReturn: dailyCashReturn(evaluation.simulation.executionModel.cash.annualYieldBps, elapsedDays),
      buyAndHoldReturn,
      directVolatilityReturn,
    }
  })
  if (buyAndHold.size !== observations.length || directVolatility.size !== observations.length) {
    throw new TypeError('qualification series dates are not exactly aligned')
  }

  return Schema.decodeUnknownSync(
    QualificationSeriesSchema,
    StrictParseOptions,
  )({
    schemaVersion: 'bayn.qualification-series.v1',
    runId: evaluation.runId,
    observations,
    rebalanceExecutionDates: evaluation.signalDecisions.map((decision) => decision.executionDate),
  })
}

export const calculateQualificationPower = (
  policy: QualificationStatisticsPolicy,
  availableCompleteRebalanceBlocks: number,
  availableCompleteSessions: number,
): PowerAnalysis => {
  const decoded = Schema.decodeUnknownSync(QualificationStatisticsPolicySchema, StrictParseOptions)(policy)
  const standardizedEffect =
    decoded.power.minimumDetectableAnnualizedExcessReturn / decoded.power.assumedAnnualizedTrackingVolatility
  const estimatedBlocks = Math.ceil(((Z_ONE_SIDED_95 + Z_POWER_80) / standardizedEffect) ** 2)
  const requiredCompleteRebalanceBlocks = Math.max(decoded.power.absoluteMinimumRebalanceBlocks, estimatedBlocks)
  const requiredSessions = Math.max(
    decoded.power.absoluteMinimumSessions,
    requiredCompleteRebalanceBlocks * decoded.power.assumedSessionsPerRebalanceBlock,
  )
  return {
    schemaVersion: 'bayn.qualification-power.v1',
    method: decoded.power.method,
    oneSidedAlpha: decoded.power.oneSidedAlpha,
    targetPower: decoded.power.targetPower,
    minimumDetectableAnnualizedExcessReturn: decoded.power.minimumDetectableAnnualizedExcessReturn,
    assumedAnnualizedTrackingVolatility: decoded.power.assumedAnnualizedTrackingVolatility,
    standardizedEffect: roundStatistic(standardizedEffect),
    requiredCompleteRebalanceBlocks,
    requiredSessions,
    availableCompleteRebalanceBlocks,
    availableCompleteSessions,
    sufficient:
      availableCompleteRebalanceBlocks >= requiredCompleteRebalanceBlocks &&
      availableCompleteSessions >= requiredSessions,
  }
}

const buildCompleteBlocks = (series: QualificationSeries): readonly BlockWork[] => {
  const blocks: BlockWork[] = []
  for (let index = 0; index < series.rebalanceExecutionDates.length - 1; index += 1) {
    const startSession = series.rebalanceExecutionDates[index]
    const nextRebalanceSession = series.rebalanceExecutionDates[index + 1]
    const observations = series.observations.filter(
      (observation) => observation.sessionDate >= startSession && observation.sessionDate < nextRebalanceSession,
    )
    if (observations.length === 0 || observations[0].sessionDate !== startSession) continue
    const lastObservation = observations.at(-1)
    if (lastObservation === undefined) continue
    const material = {
      schemaVersion: 'bayn.qualification-block.v1',
      ordinal: blocks.length,
      startSession,
      endSession: lastObservation.sessionDate,
      nextRebalanceSession,
      observations,
    }
    blocks.push({
      evidence: {
        ordinal: material.ordinal,
        startSession,
        endSession: material.endSession,
        nextRebalanceSession,
        observationCount: observations.length,
        contentHash: canonicalHashV1(material),
      },
      observations,
    })
  }
  return blocks
}

const strongerBenchmark = (
  observations: readonly QualificationObservation[],
  annualizationSessions: number,
): { readonly name: 'buy-and-hold' | 'direct-volatility-timing'; readonly sharpe: number } => {
  const buyAndHold = sharpe(
    observations.map((observation) => observation.buyAndHoldReturn - observation.cashReturn),
    annualizationSessions,
  )
  const directVolatility = sharpe(
    observations.map((observation) => observation.directVolatilityReturn - observation.cashReturn),
    annualizationSessions,
  )
  return directVolatility > buyAndHold
    ? { name: 'direct-volatility-timing', sharpe: directVolatility }
    : { name: 'buy-and-hold', sharpe: buyAndHold }
}

const makeRandomIndex = (seedHash: string) => {
  let state = Number.parseInt(seedHash.slice(0, 8), 16) || 0x9e3779b9
  const draw = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
  return (maximum: number): number => {
    if (!Number.isInteger(maximum) || maximum <= 0) throw new TypeError('random index maximum must be positive')
    const limit = Math.floor(0x1_0000_0000 / maximum) * maximum
    let value = draw()
    while (value >= limit) value = draw()
    return value % maximum
  }
}

const nearestRankLowerQuantile = (values: readonly number[], probability: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.max(1, Math.ceil(probability * sorted.length))
  return sorted[rank - 1]
}

const runBootstrap = (
  series: QualificationSeries,
  blocks: readonly BlockWork[],
  policy: QualificationStatisticsPolicy,
  priorTrialCount: number,
): typeof BootstrapAnalysisSchema.Type => {
  const benchmark = strongerBenchmark(series.observations, policy.annualizationSessions)
  const adjustedOneSidedAlpha = policy.confidence.familyOneSidedAlpha / (priorTrialCount + 1)
  const tailSampleCount = Math.floor(policy.bootstrap.samples * adjustedOneSidedAlpha)
  const seedHash = canonicalHashV1({
    schemaVersion: 'bayn.qualification-bootstrap-seed.v1',
    namespace: policy.bootstrap.seedNamespace,
    runId: series.runId,
  })
  const annualizedExcessReturnSamples: number[] = []
  const sharpeDifferenceSamples: number[] = []

  if (blocks.length > 0) {
    const randomIndex = makeRandomIndex(seedHash)
    for (let sample = 0; sample < policy.bootstrap.samples; sample += 1) {
      const candidateReturns: number[] = []
      const benchmarkReturns: number[] = []
      for (let draw = 0; draw < blocks.length; draw += 1) {
        const block = blocks[randomIndex(blocks.length)]
        for (const observation of block.observations) {
          candidateReturns.push(observation.strategyReturn - observation.cashReturn)
          benchmarkReturns.push(
            (benchmark.name === 'buy-and-hold' ? observation.buyAndHoldReturn : observation.directVolatilityReturn) -
              observation.cashReturn,
          )
        }
      }
      annualizedExcessReturnSamples.push(roundStatistic(mean(candidateReturns) * policy.annualizationSessions))
      sharpeDifferenceSamples.push(
        roundStatistic(
          sharpe(candidateReturns, policy.annualizationSessions) -
            sharpe(benchmarkReturns, policy.annualizationSessions),
        ),
      )
    }
  }

  const samplesHash = canonicalHashV1({
    schemaVersion: 'bayn.qualification-bootstrap-samples.v1',
    annualizedExcessReturnSamples,
    sharpeDifferenceSamples,
  })
  return {
    schemaVersion: 'bayn.paired-block-bootstrap.v1',
    method: policy.bootstrap.method,
    selectedBenchmark: benchmark.name,
    selectedBenchmarkSharpe: roundStatistic(benchmark.sharpe),
    seedHash,
    requestedSamples: policy.bootstrap.samples,
    producedSamples: annualizedExcessReturnSamples.length,
    adjustedOneSidedAlpha,
    tailSampleCount,
    minimumTailSamples: policy.confidence.minimumTailSamples,
    tailResolutionSufficient: tailSampleCount >= policy.confidence.minimumTailSamples,
    annualizedExcessReturnLowerBound: roundStatistic(
      nearestRankLowerQuantile(annualizedExcessReturnSamples, adjustedOneSidedAlpha),
    ),
    sharpeDifferenceLowerBound: roundStatistic(
      nearestRankLowerQuantile(sharpeDifferenceSamples, adjustedOneSidedAlpha),
    ),
    annualizedExcessReturnSamples,
    sharpeDifferenceSamples,
    samplesHash,
  }
}

const compoundedReturn = (returns: readonly number[]): number =>
  returns.reduce((growth, value) => growth * (1 + value), 1) - 1

const maximumDrawdown = (returns: readonly number[]): number => {
  let equity = 1
  let peak = 1
  let drawdown = 0
  for (const value of returns) {
    equity *= 1 + value
    peak = Math.max(peak, equity)
    drawdown = Math.max(drawdown, 1 - equity / peak)
  }
  return roundStatistic(drawdown)
}

const runWalkForward = (
  series: QualificationSeries,
  policy: QualificationStatisticsPolicy,
): typeof WalkForwardAnalysisSchema.Type => {
  const folds: (typeof WalkForwardFoldSchema.Type)[] = []
  const { minimumTrainingSessions, testSessions } = policy.walkForward
  for (
    let testStart = minimumTrainingSessions;
    testStart + testSessions <= series.observations.length;
    testStart += testSessions
  ) {
    const test = series.observations.slice(testStart, testStart + testSessions)
    const strategyReturns = test.map((observation) => observation.strategyReturn)
    const cashReturns = test.map((observation) => observation.cashReturn)
    const strategyReturn = compoundedReturn(strategyReturns)
    const cashReturn = compoundedReturn(cashReturns)
    const excessReturn = strategyReturn - cashReturn
    const drawdown = maximumDrawdown(strategyReturns)
    const positiveExcess = excessReturn > 0
    const drawdownWithinLimit = drawdown <= policy.walkForward.maximumFoldDrawdown
    const lastTestObservation = test.at(-1)
    if (lastTestObservation === undefined) throw new Error('walk-forward fold has no test observations')
    const material = {
      schemaVersion: 'bayn.walk-forward-fold.v1' as const,
      ordinal: folds.length,
      trainingStart: series.observations[0].sessionDate,
      trainingEnd: series.observations[testStart - 1].sessionDate,
      testStart: test[0].sessionDate,
      testEnd: lastTestObservation.sessionDate,
      testObservationCount: test.length,
      strategyReturn: roundStatistic(strategyReturn),
      cashReturn: roundStatistic(cashReturn),
      excessReturn: roundStatistic(excessReturn),
      maximumDrawdown: drawdown,
      positiveExcess,
      drawdownWithinLimit,
    }
    folds.push({
      ...material,
      contentHash: canonicalHashV1(material),
    })
  }
  const positiveFolds = folds.filter((fold) => fold.positiveExcess).length
  const positiveFoldFraction = folds.length === 0 ? 0 : positiveFolds / folds.length
  return {
    schemaVersion: 'bayn.walk-forward.v1',
    method: policy.walkForward.method,
    folds,
    requiredFolds: policy.walkForward.minimumFolds,
    positiveFolds,
    positiveFoldFraction: roundStatistic(positiveFoldFraction),
    requiredPositiveFoldFraction: policy.walkForward.minimumPositiveFoldFraction,
    allDrawdownsWithinLimit: folds.every((fold) => fold.drawdownWithinLimit),
    maximumFoldDrawdown: folds.reduce((maximum, fold) => Math.max(maximum, fold.maximumDrawdown), 0),
    sufficient: folds.length >= policy.walkForward.minimumFolds,
  }
}

const decodeSeriesSync = Schema.decodeUnknownSync(QualificationSeriesSchema, StrictParseOptions)
const decodePolicySync = Schema.decodeUnknownSync(QualificationStatisticsPolicySchema, StrictParseOptions)
const decodeAnalysisSync = Schema.decodeUnknownSync(QualificationAnalysisSchema, StrictParseOptions)

export const analyzeQualification = (
  input: QualificationSeries,
  policyInput: QualificationStatisticsPolicy,
  priorTrialRunIdsInput: readonly string[],
): QualificationAnalysis => {
  const series = decodeSeriesSync(input)
  const policy = decodePolicySync(policyInput)
  const priorTrialRunIds = Schema.decodeUnknownSync(
    Schema.Array(Sha256Schema),
    StrictParseOptions,
  )(priorTrialRunIdsInput)
  const lineageIssues = canonicalDates('priorTrialRunIds', priorTrialRunIds)
  if (lineageIssues.length > 0) throw new TypeError('prior trial run IDs must be unique and sorted')

  const blocks = buildCompleteBlocks(series)
  const availableCompleteSessions = blocks.reduce((total, block) => total + block.evidence.observationCount, 0)
  const power = calculateQualificationPower(policy, blocks.length, availableCompleteSessions)
  const bootstrap = runBootstrap(series, blocks, policy, priorTrialRunIds.length)
  const walkForward = runWalkForward(series, policy)
  const gates = [
    {
      name: 'power',
      passed: power.sufficient,
      actual: `${power.availableCompleteRebalanceBlocks} blocks/${power.availableCompleteSessions} sessions`,
      required: `${power.requiredCompleteRebalanceBlocks} blocks/${power.requiredSessions} sessions`,
    },
    {
      name: 'bootstrap_tail_resolution',
      passed: bootstrap.tailResolutionSufficient,
      actual: bootstrap.tailSampleCount,
      required: bootstrap.minimumTailSamples,
    },
    {
      name: 'annualized_excess_return_lower_bound',
      passed: bootstrap.annualizedExcessReturnLowerBound > 0,
      actual: bootstrap.annualizedExcessReturnLowerBound,
      required: '>0',
    },
    {
      name: 'sharpe_difference_lower_bound',
      passed: bootstrap.sharpeDifferenceLowerBound > 0,
      actual: bootstrap.sharpeDifferenceLowerBound,
      required: '>0',
    },
    {
      name: 'walk_forward_folds',
      passed: walkForward.sufficient,
      actual: walkForward.folds.length,
      required: walkForward.requiredFolds,
    },
    {
      name: 'walk_forward_positive_fraction',
      passed: walkForward.sufficient && walkForward.positiveFoldFraction >= walkForward.requiredPositiveFoldFraction,
      actual: walkForward.positiveFoldFraction,
      required: `>=${walkForward.requiredPositiveFoldFraction}`,
    },
    {
      name: 'walk_forward_drawdown',
      passed: walkForward.sufficient && walkForward.allDrawdownsWithinLimit,
      actual: walkForward.maximumFoldDrawdown,
      required: `<=${policy.walkForward.maximumFoldDrawdown}`,
    },
  ] as const

  const insufficientReasons = [
    ...(power.availableCompleteRebalanceBlocks < power.requiredCompleteRebalanceBlocks
      ? ['INSUFFICIENT_POWER_BLOCKS']
      : []),
    ...(power.availableCompleteSessions < power.requiredSessions ? ['INSUFFICIENT_POWER_SESSIONS'] : []),
    ...(!bootstrap.tailResolutionSufficient ? ['INSUFFICIENT_BOOTSTRAP_TAIL'] : []),
    ...(!walkForward.sufficient ? ['INSUFFICIENT_WALK_FORWARD_FOLDS'] : []),
  ]
  const rejectedReasons = [
    ...(bootstrap.annualizedExcessReturnLowerBound <= 0 ? ['NON_POSITIVE_EXCESS_RETURN_LCB'] : []),
    ...(bootstrap.sharpeDifferenceLowerBound <= 0 ? ['NON_POSITIVE_SHARPE_DIFFERENCE_LCB'] : []),
    ...(walkForward.sufficient && walkForward.positiveFoldFraction < walkForward.requiredPositiveFoldFraction
      ? ['WALK_FORWARD_POSITIVE_FRACTION_FAILED']
      : []),
    ...(walkForward.sufficient && !walkForward.allDrawdownsWithinLimit ? ['WALK_FORWARD_DRAWDOWN_FAILED'] : []),
  ]
  const status = insufficientReasons.length > 0 ? 'INSUFFICIENT' : rejectedReasons.length > 0 ? 'REJECTED' : 'PASS'
  const material = {
    schemaVersion: 'bayn.qualification-analysis.v1' as const,
    runId: series.runId,
    policy,
    priorTrialRunIds,
    candidateOrdinal: priorTrialRunIds.length + 1,
    completeBlocks: blocks.map((block) => block.evidence),
    power,
    bootstrap,
    walkForward,
    gates,
    status,
    reasonCodes: status === 'INSUFFICIENT' ? insufficientReasons : rejectedReasons,
  }
  return decodeAnalysisSync({ ...material, analysisHash: canonicalHashV1(material) })
}
