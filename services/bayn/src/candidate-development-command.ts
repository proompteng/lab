import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import { NodeRuntime } from '@effect/platform-node'
import { Data, Effect, pipe, Result, Schema } from 'effect'

import {
  candidateDevelopmentComparisonSemantics,
  candidateDevelopmentStatisticsPolicy,
  runCandidateDevelopment,
  type CandidateDevelopmentEffects,
  type CandidateDevelopmentEvaluation,
  type CandidateDevelopmentPreflightInput,
  type CandidateDevelopmentReport,
  type CandidateDevelopmentRunFailure,
} from './candidate-development'
import {
  type DailyPerformancePoint,
  DailyPerformanceSeriesArtifactSchema,
  DailyPositionMarksArtifactSchema,
  EquitySeriesArtifactSchema,
  EvaluationEventsSchema,
  EvaluationSummarySchema,
  InputManifestArtifactSchema,
  MarkedEquityReconciliationSchema,
  RiskBalancedTrendSignalDecisionsArtifactSchema,
} from './evidence-contracts'
import { canonicalHashV1Result, type CanonicalHashFailure } from './hash'
import { defaultProtocolDocument, ExecutionModelSchema } from './protocol'
import {
  DigitsSchema,
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  SignedMicrosSchema,
  SourceRevisionSchema,
  strictParseOptions,
} from './schemas'
import { calculateExactPerformanceMetrics, buildVerdict } from './simulation/metrics'
import type { EvaluationResult, PerformanceMetrics } from './types'

export const candidateDevelopmentExecutableProgramSchemaVersion =
  'bayn.candidate-development-executable-program.v1' as const

export interface CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements> {
  readonly schemaVersion: typeof candidateDevelopmentExecutableProgramSchemaVersion
  readonly input: CandidateDevelopmentPreflightInput
  readonly effects: CandidateDevelopmentEffects<Registration, DevelopmentData, Error, Requirements>
}

type CandidateDevelopmentComparisonGateName =
  (typeof candidateDevelopmentComparisonSemantics.gates)[keyof typeof candidateDevelopmentComparisonSemantics.gates]['name']

export interface CandidateDevelopmentCommandGate {
  readonly name:
    | CandidateDevelopmentComparisonGateName
    | 'double_cost_return'
    | 'economic_verdict'
    | 'baseline_terminal_cash'
    | 'stressed_terminal_cash'
  readonly passed: boolean
  readonly actual: number | boolean
  readonly required: number | boolean
}

export interface CandidateDevelopmentCommandDecision {
  readonly status: 'PASS' | 'HOLD_REJECT'
  readonly selectedBenchmark: 'buy-and-hold' | 'direct-volatility-timing'
  readonly gates: readonly CandidateDevelopmentCommandGate[]
}

export interface CandidateDevelopmentCommandReportMaterial {
  readonly schemaVersion: 'bayn.candidate-development-command-report.v1'
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly strategyProtocolHash: string
  readonly decision: CandidateDevelopmentCommandDecision
  readonly baseline: EvaluationResult
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
        | 'event-mismatch'
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
      readonly reason: 'summary-mismatch' | 'series-mismatch'
      readonly index: number | null
      readonly field: string
      readonly expected: unknown
      readonly observed: unknown
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

const terminalCash = (marks: EvaluationResult['simulation']['dailyMarks']): boolean => {
  const last = marks.at(-1)
  return last !== undefined && last.positions.every((position) => position.quantityMicros === '0')
}

type CandidateDevelopmentPerformanceSeries = readonly (DailyPerformancePoint & {
  readonly positions?: EvaluationResult['simulation']['dailyMarks'][number]['positions']
})[]

type CandidateDevelopmentPerformanceSeriesName = Extract<
  CandidateDevelopmentCommandFailure,
  { readonly _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid' }
>['series']

const performanceMetricFields = [
  'observations',
  'totalReturn',
  'annualizedReturn',
  'annualizedVolatility',
  'sharpe',
  'maximumDrawdown',
  'annualTurnover',
  'totalFeesMicros',
  'totalSpreadCostMicros',
  'totalSlippageCostMicros',
  'totalCashYieldMicros',
  'endingEquityMicros',
] as const satisfies readonly (keyof PerformanceMetrics)[]

const cumulativeMicrosFields = [
  ['turnoverMicros', 'cumulativeTurnoverMicros'],
  ['feeMicros', 'cumulativeFeesMicros'],
  ['spreadCostMicros', 'cumulativeSpreadCostMicros'],
  ['slippageCostMicros', 'cumulativeSlippageCostMicros'],
  ['cashYieldMicros', 'cumulativeCashYieldMicros'],
] as const

const performanceEvidenceFailure = (
  series: CandidateDevelopmentPerformanceSeriesName,
  reason: Extract<
    CandidateDevelopmentCommandFailure,
    { readonly _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid' }
  >['reason'],
  index: number | null,
  field: string | null,
  expected: unknown,
  observed: unknown,
  cause?: unknown,
): CandidateDevelopmentCommandFailure => ({
  _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid',
  series,
  reason,
  index,
  field,
  expected,
  observed,
  ...(cause === undefined ? {} : { cause }),
})

const unsignedMicros = (
  series: CandidateDevelopmentPerformanceSeriesName,
  index: number,
  field: string,
  value: string,
): Result.Result<bigint, CandidateDevelopmentCommandFailure> =>
  /^(?:0|[1-9][0-9]*)$/.test(value)
    ? Result.succeed(BigInt(value))
    : Result.fail(performanceEvidenceFailure(series, 'micros-invalid', index, field, 'unsigned micros', value))

const recomputePerformanceMetrics = (
  seriesName: CandidateDevelopmentPerformanceSeriesName,
  points: CandidateDevelopmentPerformanceSeries,
  initialCapitalMicros: string,
): Result.Result<PerformanceMetrics, CandidateDevelopmentCommandFailure> => {
  if (points.length < 2) {
    return Result.fail(
      performanceEvidenceFailure(seriesName, 'observations-insufficient', null, null, '>=2', points.length),
    )
  }
  const initialCapital = /^(?:[1-9][0-9]*)$/.test(initialCapitalMicros)
    ? Result.succeed(BigInt(initialCapitalMicros))
    : Result.fail(
        performanceEvidenceFailure(
          seriesName,
          'micros-invalid',
          null,
          'initialCapitalMicros',
          'positive micros',
          initialCapitalMicros,
        ),
      )
  if (Result.isFailure(initialCapital)) return Result.fail(initialCapital.failure)

  const equityMicros: bigint[] = []
  const cumulative = Object.fromEntries(cumulativeMicrosFields.map(([, field]) => [field, 0n])) as Record<
    (typeof cumulativeMicrosFields)[number][1],
    bigint
  >
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    const previous = points[index - 1]
    if (previous !== undefined && previous.sessionDate >= point.sessionDate) {
      return Result.fail(
        performanceEvidenceFailure(
          seriesName,
          'session-mismatch',
          index,
          'sessionDate',
          `>${previous.sessionDate}`,
          point.sessionDate,
        ),
      )
    }
    const equity = unsignedMicros(seriesName, index, 'equityMicros', point.equityMicros)
    if (Result.isFailure(equity)) return Result.fail(equity.failure)
    if (equity.success === 0n) {
      return Result.fail(
        performanceEvidenceFailure(seriesName, 'micros-invalid', index, 'equityMicros', 'positive micros', '0'),
      )
    }
    equityMicros.push(equity.success)

    for (const [dailyField, cumulativeField] of cumulativeMicrosFields) {
      const daily = unsignedMicros(seriesName, index, dailyField, point[dailyField])
      if (Result.isFailure(daily)) return Result.fail(daily.failure)
      const observedCumulative = unsignedMicros(seriesName, index, cumulativeField, point[cumulativeField])
      if (Result.isFailure(observedCumulative)) return Result.fail(observedCumulative.failure)
      const prior = cumulative[cumulativeField]
      const expected = index === 0 ? observedCumulative.success : prior + daily.success
      if (index === 0 ? observedCumulative.success < daily.success : observedCumulative.success !== expected) {
        return Result.fail(
          performanceEvidenceFailure(
            seriesName,
            'cumulative-mismatch',
            index,
            cumulativeField,
            index === 0 ? `>=${daily.success}` : expected.toString(),
            observedCumulative.success.toString(),
          ),
        )
      }
      cumulative[cumulativeField] = observedCumulative.success
    }
  }

  return pipe(
    calculateExactPerformanceMetrics(
      equityMicros,
      cumulative.cumulativeTurnoverMicros,
      cumulative.cumulativeFeesMicros,
      cumulative.cumulativeSpreadCostMicros,
      cumulative.cumulativeSlippageCostMicros,
      cumulative.cumulativeCashYieldMicros,
      initialCapital.success,
    ),
    Result.mapError((cause) => performanceEvidenceFailure(seriesName, 'metrics-failed', null, null, null, null, cause)),
  )
}

const validatePerformanceMetrics = (
  series: CandidateDevelopmentPerformanceSeriesName,
  expected: PerformanceMetrics,
  observed: PerformanceMetrics,
): Result.Result<PerformanceMetrics, CandidateDevelopmentCommandFailure> => {
  for (const field of performanceMetricFields) {
    if (!Object.is(expected[field], observed[field])) {
      return Result.fail(
        performanceEvidenceFailure(series, 'metrics-mismatch', null, field, expected[field], observed[field]),
      )
    }
  }
  return Result.succeed(expected)
}

const validateSeriesSessions = (
  expected: CandidateDevelopmentPerformanceSeries,
  observed: CandidateDevelopmentPerformanceSeries,
  series: CandidateDevelopmentPerformanceSeriesName,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const count = Math.max(expected.length, observed.length)
  for (let index = 0; index < count; index += 1) {
    if (expected[index]?.sessionDate !== observed[index]?.sessionDate) {
      return Result.fail(
        performanceEvidenceFailure(
          series,
          'session-mismatch',
          index,
          'sessionDate',
          expected[index]?.sessionDate ?? null,
          observed[index]?.sessionDate ?? null,
        ),
      )
    }
  }
  return Result.succeed(undefined)
}

const validateSelectedStrategyEvents = (
  baseline: EvaluationResult,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const marks = baseline.simulation.dailyMarks
  const firstSession = marks.at(0)?.sessionDate
  const lastSession = marks.at(-1)?.sessionDate
  if (firstSession === undefined || lastSession === undefined) {
    return Result.fail(
      performanceEvidenceFailure('strategy', 'observations-insufficient', null, null, 'nonempty marks', marks.length),
    )
  }
  const markBySession = new Map(marks.map((mark) => [mark.sessionDate, mark] as const))
  const totals = new Map<
    string,
    { turnover: bigint; fees: bigint; spread: bigint; slippage: bigint; cashYield: bigint }
  >()
  const selectedFills = baseline.events.filter(
    (event): event is Extract<EvaluationResult['events'][number], { readonly kind: 'fill' }> =>
      event.kind === 'fill' && event.sessionDate >= firstSession && event.sessionDate <= lastSession,
  )
  for (let eventIndex = 0; eventIndex < baseline.events.length; eventIndex += 1) {
    const event = baseline.events[eventIndex]
    if (event.kind === 'decision' || event.sessionDate < firstSession || event.sessionDate > lastSession) continue
    if (!markBySession.has(event.sessionDate)) {
      return Result.fail(
        performanceEvidenceFailure(
          'strategy',
          'event-mismatch',
          null,
          'event.sessionDate',
          'selected mark session',
          event.sessionDate,
        ),
      )
    }
    const total = totals.get(event.sessionDate) ?? {
      turnover: 0n,
      fees: 0n,
      spread: 0n,
      slippage: 0n,
      cashYield: 0n,
    }
    if (event.kind === 'fill') {
      const values = Result.all({
        turnover: unsignedMicros('strategy', eventIndex, 'fill.notionalMicros', event.notionalMicros),
        spread: unsignedMicros('strategy', eventIndex, 'fill.spreadCostMicros', event.spreadCostMicros),
        slippage: unsignedMicros('strategy', eventIndex, 'fill.slippageCostMicros', event.slippageCostMicros),
      })
      if (Result.isFailure(values)) return Result.fail(values.failure)
      total.turnover += values.success.turnover
      total.spread += values.success.spread
      total.slippage += values.success.slippage
    } else if (event.kind === 'fee') {
      const fees = unsignedMicros('strategy', eventIndex, 'fee.totalMicros', event.totalMicros)
      if (Result.isFailure(fees)) return Result.fail(fees.failure)
      total.fees += fees.success
    } else {
      const cashYield = unsignedMicros('strategy', eventIndex, 'cash-yield.amountMicros', event.amountMicros)
      if (Result.isFailure(cashYield)) return Result.fail(cashYield.failure)
      total.cashYield += cashYield.success
    }
    totals.set(event.sessionDate, total)
  }
  const dailyBindings = [
    ['turnover', 'turnoverMicros'],
    ['fees', 'feeMicros'],
    ['spread', 'spreadCostMicros'],
    ['slippage', 'slippageCostMicros'],
    ['cashYield', 'cashYieldMicros'],
  ] as const
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index]
    const total = totals.get(mark.sessionDate) ?? {
      turnover: 0n,
      fees: 0n,
      spread: 0n,
      slippage: 0n,
      cashYield: 0n,
    }
    for (const [totalField, markField] of dailyBindings) {
      if (total[totalField].toString() !== mark[markField]) {
        return Result.fail(
          performanceEvidenceFailure(
            'strategy',
            'event-mismatch',
            index,
            markField,
            total[totalField].toString(),
            mark[markField],
          ),
        )
      }
    }
  }

  const orderById = new Map(baseline.simulation.orders.map((order) => [order.id, order] as const))
  if (orderById.size !== baseline.simulation.orders.length) {
    return Result.fail(
      performanceEvidenceFailure(
        'strategy',
        'event-mismatch',
        null,
        'order.id',
        'unique simulation order ids',
        baseline.simulation.orders.length - orderById.size,
      ),
    )
  }
  const filledByOrder = new Map<string, bigint>()
  for (let fillIndex = 0; fillIndex < selectedFills.length; fillIndex += 1) {
    const fill = selectedFills[fillIndex]
    const order = orderById.get(fill.orderId)
    if (
      order === undefined ||
      order.decisionId !== fill.decisionId ||
      order.sessionDate !== fill.sessionDate ||
      order.symbol !== fill.symbol ||
      order.side !== fill.side
    ) {
      return Result.fail(
        performanceEvidenceFailure(
          'strategy',
          'event-mismatch',
          null,
          'fill.orderBinding',
          fill.orderId,
          order ?? null,
        ),
      )
    }
    const quantity = unsignedMicros('strategy', fillIndex, 'fill.quantityMicros', fill.quantityMicros)
    if (Result.isFailure(quantity)) return Result.fail(quantity.failure)
    filledByOrder.set(fill.orderId, (filledByOrder.get(fill.orderId) ?? 0n) + quantity.success)
  }
  for (let orderIndex = 0; orderIndex < baseline.simulation.orders.length; orderIndex += 1) {
    const order = baseline.simulation.orders[orderIndex]
    if (order.sessionDate < firstSession || order.sessionDate > lastSession) continue
    const expectedFilledResult = unsignedMicros(
      'strategy',
      orderIndex,
      'order.filledQuantityMicros',
      order.filledQuantityMicros,
    )
    if (Result.isFailure(expectedFilledResult)) return Result.fail(expectedFilledResult.failure)
    const expectedFilled = expectedFilledResult.success
    const observedFilled = filledByOrder.get(order.id) ?? 0n
    if (expectedFilled !== observedFilled) {
      return Result.fail(
        performanceEvidenceFailure(
          'strategy',
          'event-mismatch',
          null,
          'order.filledQuantityMicros',
          expectedFilled.toString(),
          observedFilled.toString(),
        ),
      )
    }
  }
  return Result.succeed(undefined)
}

interface CandidateDevelopmentRecomputedMetrics {
  readonly strategy: PerformanceMetrics
  readonly buyAndHold: PerformanceMetrics
  readonly directVolTiming: PerformanceMetrics
  readonly doubleCostStrategy: PerformanceMetrics
}

const recomputeCandidateDevelopmentMetrics = (
  report: CandidateDevelopmentReport,
  baseline: EvaluationResult,
): Result.Result<CandidateDevelopmentRecomputedMetrics, CandidateDevelopmentCommandFailure> => {
  const strategyPoints = baseline.simulation.dailyMarks
  const stressedPoints = report.doubledCost.stressed.simulation.dailyMarks
  return pipe(
    Result.all({
      strategyEvents: validateSelectedStrategyEvents(baseline),
      buySessions: validateSeriesSessions(strategyPoints, baseline.benchmarkSeries.buyAndHold, 'buy-and-hold'),
      volSessions: validateSeriesSessions(
        strategyPoints,
        baseline.benchmarkSeries.directVolTiming,
        'direct-volatility-timing',
      ),
      doubleSessions: validateSeriesSessions(
        strategyPoints,
        baseline.benchmarkSeries.doubleCostStrategy,
        'double-cost-series',
      ),
      stressedSessions: validateSeriesSessions(strategyPoints, stressedPoints, 'double-cost-stressed'),
      strategy: recomputePerformanceMetrics('strategy', strategyPoints, baseline.initialCapitalMicros),
      buyAndHold: recomputePerformanceMetrics(
        'buy-and-hold',
        baseline.benchmarkSeries.buyAndHold,
        baseline.initialCapitalMicros,
      ),
      directVolTiming: recomputePerformanceMetrics(
        'direct-volatility-timing',
        baseline.benchmarkSeries.directVolTiming,
        baseline.initialCapitalMicros,
      ),
      doubleCostSeries: recomputePerformanceMetrics(
        'double-cost-series',
        baseline.benchmarkSeries.doubleCostStrategy,
        baseline.initialCapitalMicros,
      ),
      doubleCostStressed: recomputePerformanceMetrics(
        'double-cost-stressed',
        stressedPoints,
        baseline.initialCapitalMicros,
      ),
    }),
    Result.flatMap(({ buyAndHold, directVolTiming, doubleCostSeries, doubleCostStressed, strategy }) =>
      pipe(
        Result.all({
          strategy: validatePerformanceMetrics('strategy', strategy, baseline.strategy),
          buyAndHold: validatePerformanceMetrics('buy-and-hold', buyAndHold, baseline.buyAndHold),
          directVolTiming: validatePerformanceMetrics(
            'direct-volatility-timing',
            directVolTiming,
            baseline.directVolTiming,
          ),
          doubleCostSeries: validatePerformanceMetrics(
            'double-cost-series',
            doubleCostSeries,
            baseline.doubleCostStrategy,
          ),
          doubleCostStressed: validatePerformanceMetrics(
            'double-cost-stressed',
            doubleCostStressed,
            baseline.doubleCostStrategy,
          ),
        }),
        Result.map(
          ({ buyAndHold: buy, directVolTiming: vol, doubleCostStressed: doubleCost, strategy: candidate }) => ({
            strategy: candidate,
            buyAndHold: buy,
            directVolTiming: vol,
            doubleCostStrategy: doubleCost,
          }),
        ),
      ),
    ),
  )
}

const markedEquityFailure = (
  reason: Extract<
    CandidateDevelopmentCommandFailure,
    { readonly _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid' }
  >['reason'],
  index: number | null,
  field: string,
  expected: unknown,
  observed: unknown,
): CandidateDevelopmentCommandFailure => ({
  _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
  reason,
  index,
  field,
  expected,
  observed,
})

const validateMarkedEquity = (
  baseline: EvaluationResult,
  strategy: PerformanceMetrics,
): Result.Result<void, CandidateDevelopmentCommandFailure> => {
  const reconciliation = baseline.markedEquityReconciliation
  const summaryFields = [
    ['runId', baseline.runId, reconciliation.runId],
    ['toleranceMicros', '0', reconciliation.toleranceMicros],
    ['maximumDailyDifferenceMicros', '0', reconciliation.maximumDailyDifferenceMicros],
    ['evaluatorTotalFeesMicros', strategy.totalFeesMicros, reconciliation.evaluatorTotalFeesMicros],
    ['reconstructedTotalFeesMicros', strategy.totalFeesMicros, reconciliation.reconstructedTotalFeesMicros],
    ['feeDifferenceMicros', '0', reconciliation.feeDifferenceMicros],
    ['evaluatorEndingEquityMicros', strategy.endingEquityMicros, reconciliation.evaluatorEndingEquityMicros],
    ['reconstructedEndingEquityMicros', strategy.endingEquityMicros, reconciliation.reconstructedEndingEquityMicros],
    ['differenceMicros', '0', reconciliation.differenceMicros],
    ['exact', true, reconciliation.exact],
    ['withinTolerance', true, reconciliation.withinTolerance],
  ] as const
  for (const [field, expected, observed] of summaryFields) {
    if (!Object.is(expected, observed)) {
      return Result.fail(markedEquityFailure('summary-mismatch', null, field, expected, observed))
    }
  }
  const reconstructedCash = unsignedMicros(
    'strategy',
    baseline.equitySeries.length,
    'reconstructedCashMicros',
    reconciliation.reconstructedCashMicros,
  )
  if (Result.isFailure(reconstructedCash)) return Result.fail(reconstructedCash.failure)
  const reconstructedPositionValue = unsignedMicros(
    'strategy',
    baseline.equitySeries.length,
    'reconstructedPositionValueMicros',
    reconciliation.reconstructedPositionValueMicros,
  )
  if (Result.isFailure(reconstructedPositionValue)) return Result.fail(reconstructedPositionValue.failure)
  if (reconstructedCash.success + reconstructedPositionValue.success !== BigInt(strategy.endingEquityMicros)) {
    return Result.fail(
      markedEquityFailure(
        'summary-mismatch',
        null,
        'reconstructedCashPlusPositionValueMicros',
        strategy.endingEquityMicros,
        (reconstructedCash.success + reconstructedPositionValue.success).toString(),
      ),
    )
  }

  const equityBySession = new Map(baseline.equitySeries.map((point) => [point.sessionDate, point] as const))
  if (equityBySession.size !== baseline.equitySeries.length) {
    return Result.fail(
      markedEquityFailure(
        'series-mismatch',
        null,
        'sessionDate',
        'strictly unique equity-series sessions',
        baseline.equitySeries.length - equityBySession.size,
      ),
    )
  }
  for (let index = 0; index < baseline.equitySeries.length; index += 1) {
    const point = baseline.equitySeries[index]
    const previous = baseline.equitySeries[index - 1]
    if (previous !== undefined && previous.sessionDate >= point.sessionDate) {
      return Result.fail(
        markedEquityFailure('series-mismatch', index, 'sessionDate', `>${previous.sessionDate}`, point.sessionDate),
      )
    }
    const exact = point.differenceMicros === '0' && point.evaluatorEquityMicros === point.reconstructedEquityMicros
    if (!exact) {
      return Result.fail(
        markedEquityFailure(
          'series-mismatch',
          index,
          'equity',
          { differenceMicros: '0', evaluatorEqualsReconstructed: true },
          {
            differenceMicros: point.differenceMicros,
            evaluatorEqualsReconstructed: point.evaluatorEquityMicros === point.reconstructedEquityMicros,
          },
        ),
      )
    }
  }
  for (let index = 0; index < baseline.simulation.dailyMarks.length; index += 1) {
    const mark = baseline.simulation.dailyMarks[index]
    const point = equityBySession.get(mark.sessionDate)
    if (point?.evaluatorEquityMicros !== mark.equityMicros) {
      return Result.fail(
        markedEquityFailure(
          'series-mismatch',
          index,
          'selectedMarkEquityMicros',
          mark.equityMicros,
          point?.evaluatorEquityMicros ?? null,
        ),
      )
    }
  }
  return Result.succeed(undefined)
}

const rebuildCandidateDevelopmentEconomicVerdict = (
  baseline: EvaluationResult,
  metrics: CandidateDevelopmentRecomputedMetrics,
): EvaluationResult['verdict'] =>
  buildVerdict(metrics.strategy, metrics.buyAndHold, metrics.directVolTiming, metrics.doubleCostStrategy, {
    universe: baseline.inputManifest.symbols.map(({ symbol }) => symbol),
    directVolatilityTarget: defaultProtocolDocument.directVolatilityTarget,
    initialCapitalMicros: baseline.initialCapitalMicros,
    executionModel: baseline.simulation.executionModel,
    thresholds: defaultProtocolDocument.thresholds,
  })

const economicGateEqual = (
  expected: EvaluationResult['verdict']['gates'][number],
  observed: EvaluationResult['verdict']['gates'][number],
): boolean =>
  expected.name === observed.name &&
  expected.passed === observed.passed &&
  Object.is(expected.actual, observed.actual) &&
  Object.is(expected.required, observed.required)

export const deriveCandidateDevelopmentEconomicPass = (
  baseline: EvaluationResult,
  metrics: CandidateDevelopmentRecomputedMetrics,
): Result.Result<boolean, CandidateDevelopmentCommandFailure> => {
  const expectedVerdict = rebuildCandidateDevelopmentEconomicVerdict(baseline, metrics)
  const expectedGateNames = expectedVerdict.gates.map((gate) => gate.name)
  const observedGateNames = baseline.verdict.gates.map((gate) => gate.name)
  if (
    observedGateNames.length !== expectedGateNames.length ||
    expectedGateNames.some((expected, index) => observedGateNames[index] !== expected)
  ) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandEconomicGateSetInvalid',
      expectedGateNames,
      observedGateNames,
    })
  }
  for (let index = 0; index < expectedVerdict.gates.length; index += 1) {
    const expected = expectedVerdict.gates[index]
    const observed = baseline.verdict.gates[index]
    if (expected === undefined || observed === undefined || !economicGateEqual(expected, observed)) {
      if (expected !== undefined && observed !== undefined) {
        return Result.fail({
          _tag: 'CandidateDevelopmentCommandEconomicGateInvalid',
          index,
          expected,
          observed,
        })
      }
      return Result.fail({
        _tag: 'CandidateDevelopmentCommandEconomicGateSetInvalid',
        expectedGateNames,
        observedGateNames,
      })
    }
  }
  const economicPass = expectedVerdict.gates.every((gate) => gate.passed)
  const failedGateNames = expectedVerdict.gates.filter((gate) => !gate.passed).map((gate) => gate.name)
  const expectedStatus = economicPass ? 'PASS' : 'FAIL_CLOSED'
  return baseline.verdict.status === expectedStatus
    ? Result.succeed(economicPass)
    : Result.fail({
        _tag: 'CandidateDevelopmentCommandEconomicVerdictInvalid',
        expectedStatus,
        observedStatus: baseline.verdict.status,
        failedGateNames,
      })
}

const decideCandidateDevelopment = (
  report: CandidateDevelopmentReport,
  baseline: EvaluationResult,
  doubledCostAnnualizedReturn: number,
  economicPass: boolean,
): CandidateDevelopmentCommandDecision => {
  const { bootstrap, power, walkForward } = report.comparisonSemantics.analysis
  const protocolGates = candidateDevelopmentComparisonSemantics.gates
  const gates: readonly CandidateDevelopmentCommandGate[] = [
    {
      name: protocolGates.power.name,
      passed: power.sufficient,
      actual: power.sufficient,
      required: true,
    },
    {
      name: protocolGates.bootstrapTailResolution.name,
      passed: bootstrap.tailResolutionSufficient,
      actual: bootstrap.tailSampleCount,
      required: bootstrap.minimumTailSamples,
    },
    {
      name: protocolGates.annualizedExcessReturnLowerBound.name,
      passed: bootstrap.annualizedReturnDifferenceLowerBound > 0,
      actual: bootstrap.annualizedReturnDifferenceLowerBound,
      required: 0,
    },
    {
      name: protocolGates.sharpeDifferenceLowerBound.name,
      passed: bootstrap.sharpeDifferenceLowerBound > 0,
      actual: bootstrap.sharpeDifferenceLowerBound,
      required: 0,
    },
    {
      name: protocolGates.walkForwardFolds.name,
      passed: walkForward.sufficient,
      actual: walkForward.folds.length,
      required: walkForward.requiredFolds,
    },
    {
      name: protocolGates.walkForwardPositiveFraction.name,
      passed: walkForward.positiveFoldFraction >= walkForward.requiredPositiveFoldFraction,
      actual: walkForward.positiveFoldFraction,
      required: walkForward.requiredPositiveFoldFraction,
    },
    {
      name: protocolGates.walkForwardDrawdown.name,
      passed: walkForward.allDrawdownsWithinLimit,
      actual: walkForward.maximumFoldDrawdown,
      required: candidateDevelopmentStatisticsPolicy.walkForward.maximumFoldDrawdown,
    },
    {
      name: 'double_cost_return',
      passed: doubledCostAnnualizedReturn > 0,
      actual: doubledCostAnnualizedReturn,
      required: 0,
    },
    {
      name: 'economic_verdict',
      passed: economicPass,
      actual: economicPass,
      required: true,
    },
    {
      name: 'baseline_terminal_cash',
      passed: terminalCash(baseline.simulation.dailyMarks),
      actual: terminalCash(baseline.simulation.dailyMarks),
      required: true,
    },
    {
      name: 'stressed_terminal_cash',
      passed: terminalCash(report.doubledCost.stressed.simulation.dailyMarks),
      actual: terminalCash(report.doubledCost.stressed.simulation.dailyMarks),
      required: true,
    },
  ]
  return {
    status: gates.every((gate) => gate.passed) ? 'PASS' : 'HOLD_REJECT',
    selectedBenchmark: bootstrap.selectedBenchmark,
    gates,
  }
}

export const buildCandidateDevelopmentCommandReport = (
  report: CandidateDevelopmentReport,
  baseline: EvaluationResult,
): Result.Result<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure> =>
  pipe(
    recomputeCandidateDevelopmentMetrics(report, baseline),
    Result.flatMap((metrics) =>
      pipe(
        Result.all({
          markedEquity: validateMarkedEquity(baseline, metrics.strategy),
          economicPass: deriveCandidateDevelopmentEconomicPass(baseline, metrics),
        }),
        Result.map(({ economicPass }) => ({
          doubledCostAnnualizedReturn: metrics.doubleCostStrategy.annualizedReturn,
          economicPass,
        })),
      ),
    ),
    Result.flatMap(({ doubledCostAnnualizedReturn, economicPass }) => {
      const material: CandidateDevelopmentCommandReportMaterial = {
        schemaVersion: 'bayn.candidate-development-command-report.v1',
        candidateOrdinal: report.protocolIdentity.candidateOrdinal,
        priorTrialCount: report.protocolIdentity.priorTrialCount,
        strategyProtocolHash: report.comparisonSemantics.strategyProtocolHash,
        decision: decideCandidateDevelopment(report, baseline, doubledCostAnnualizedReturn, economicPass),
        baseline,
        development: report,
      }
      return pipe(
        canonicalHashV1Result(material),
        Result.mapError(
          (cause): CandidateDevelopmentCommandFailure => ({
            _tag: 'CandidateDevelopmentCommandHashFailed',
            cause,
          }),
        ),
        Result.map((contentHash) => ({ ...material, contentHash })),
      )
    }),
  )

export const executeCandidateDevelopmentProgram = <Registration, DevelopmentData, Error, Requirements>(
  program: CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements>,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure | Error, Requirements> => {
  let evaluation: CandidateDevelopmentEvaluation | undefined
  const effects: CandidateDevelopmentEffects<Registration, DevelopmentData, Error, Requirements> = {
    ...program.effects,
    evaluateDevelopment: (data, preflight) =>
      program.effects.evaluateDevelopment(data, preflight).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            evaluation = value
          }),
        ),
      ),
  }
  return runCandidateDevelopment(program.input, effects).pipe(
    Effect.flatMap((report) =>
      evaluation === undefined
        ? Effect.fail<CandidateDevelopmentCommandFailure>({ _tag: 'CandidateDevelopmentCommandEvaluationMissing' })
        : Effect.fromResult(buildCandidateDevelopmentCommandReport(report, evaluation.baseline)),
    ),
  )
}

export const renderCandidateDevelopmentCommandReport = (report: CandidateDevelopmentCommandReport): string =>
  `${JSON.stringify(report)}\n`

export type CandidateDevelopmentCommandReportWriter = (
  renderedReport: string,
) => Effect.Effect<void, CandidateDevelopmentCommandFailure>

const writeCandidateDevelopmentCommandReportToStdout: CandidateDevelopmentCommandReportWriter = (renderedReport) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolveWrite, rejectWrite) => {
        process.stdout.write(renderedReport, (error) => {
          if (error === null || error === undefined) resolveWrite()
          else rejectWrite(error)
        })
      }),
    catch: (cause): CandidateDevelopmentCommandFailure => ({
      _tag: 'CandidateDevelopmentCommandOutputFailed',
      cause,
    }),
  })

export const writeCandidateDevelopmentCommandReport = (
  report: CandidateDevelopmentCommandReport,
  writer: CandidateDevelopmentCommandReportWriter = writeCandidateDevelopmentCommandReportToStdout,
): Effect.Effect<void, CandidateDevelopmentCommandFailure> =>
  writer(renderCandidateDevelopmentCommandReport(report)).pipe(Effect.uninterruptible)

export const runCandidateDevelopmentCommand = <Registration, DevelopmentData, Error, Requirements>(
  program: CandidateDevelopmentExecutableProgram<Registration, DevelopmentData, Error, Requirements>,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure | Error, Requirements> =>
  executeCandidateDevelopmentProgram(program).pipe(Effect.tap(writeCandidateDevelopmentCommandReport))

type ExecutableProgram = CandidateDevelopmentExecutableProgram<
  unknown,
  unknown,
  CandidateDevelopmentCommandFailure,
  never
>

const CandidateDevelopmentPreflightInputSchema = Schema.Struct({
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

const CandidateDevelopmentEvaluationSchema = Schema.Struct({
  baseline: CandidateDevelopmentEvaluationResultSchema,
  comparisonSemantics: CandidateDevelopmentComparisonSemanticsEvidenceBoundarySchema,
  stressed: CandidateDevelopmentDoubledCostRunSchema,
})

const decodeCandidateDevelopmentPreflightInput = Schema.decodeUnknownResult(
  CandidateDevelopmentPreflightInputSchema,
  strictParseOptions,
)

const decodeCandidateDevelopmentEvaluation = Schema.decodeUnknownResult(
  CandidateDevelopmentEvaluationSchema,
  strictParseOptions,
)

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

export const validateCandidateDevelopmentExecutableProgram = (
  value: unknown,
): Result.Result<ExecutableProgram, CandidateDevelopmentCommandFailure> => {
  const program = recordOf(value)
  if (program === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'module-export-missing' })
  }
  if (program.schemaVersion !== candidateDevelopmentExecutableProgramSchemaVersion) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'schema-version-mismatch' })
  }
  if (recordOf(program.input) === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'input-missing' })
  }
  const effects = recordOf(program.effects)
  if (effects === undefined) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effects-missing' })
  }
  if (
    typeof effects.preregisterCandidate !== 'function' ||
    typeof effects.loadDevelopmentData !== 'function' ||
    typeof effects.evaluateDevelopment !== 'function'
  ) {
    return Result.fail({ _tag: 'CandidateDevelopmentCommandProgramInvalid', reason: 'effect-function-missing' })
  }
  const input = decodeCandidateDevelopmentPreflightInput(program.input)
  if (Result.isFailure(input)) {
    return Result.fail({
      _tag: 'CandidateDevelopmentCommandProgramInvalid',
      reason: 'input-invalid',
      cause: input.failure,
    })
  }
  const typedEffects = effects as unknown as ExecutableProgram['effects']
  return Result.succeed({
    schemaVersion: candidateDevelopmentExecutableProgramSchemaVersion,
    input: input.success,
    effects: {
      ...typedEffects,
      evaluateDevelopment: (data, preflight) =>
        typedEffects.evaluateDevelopment(data, preflight).pipe(
          Effect.flatMap((evaluation) => {
            const decoded = decodeCandidateDevelopmentEvaluation(evaluation)
            return Result.isSuccess(decoded)
              ? Effect.succeed(decoded.success as CandidateDevelopmentEvaluation)
              : Effect.fail<CandidateDevelopmentCommandFailure>({
                  _tag: 'CandidateDevelopmentCommandProgramInvalid',
                  reason: 'evaluation-invalid',
                  cause: decoded.failure,
                })
          }),
        ),
    },
  })
}

export type CandidateDevelopmentModuleImporter = (
  moduleUrl: string,
) => Effect.Effect<unknown, CandidateDevelopmentCommandFailure>

const importCandidateDevelopmentModule: CandidateDevelopmentModuleImporter = (moduleUrl) =>
  Effect.tryPromise({
    try: () => import(moduleUrl),
    catch: (cause): CandidateDevelopmentCommandFailure => ({
      _tag: 'CandidateDevelopmentCommandModuleLoadFailed',
      modulePath: moduleUrl,
      cause,
    }),
  })

export const loadCandidateDevelopmentExecutableProgram = (
  modulePath: string,
  importer: CandidateDevelopmentModuleImporter = importCandidateDevelopmentModule,
): Effect.Effect<ExecutableProgram, CandidateDevelopmentCommandFailure> =>
  importer(pathToFileURL(resolve(modulePath)).href).pipe(
    Effect.uninterruptible,
    Effect.flatMap((module) =>
      Effect.fromResult(validateCandidateDevelopmentExecutableProgram(recordOf(module)?.candidateDevelopmentProgram)),
    ),
  )

const modulePath = process.argv.at(2)

const executeLoadedCandidateDevelopmentProgram = (
  program: ExecutableProgram,
): Effect.Effect<CandidateDevelopmentCommandReport, CandidateDevelopmentCommandFailure> =>
  runCandidateDevelopmentCommand(program).pipe(
    Effect.mapError(
      (cause): CandidateDevelopmentCommandFailure => ({
        _tag: 'CandidateDevelopmentCommandProgramExecutionFailed',
        cause,
      }),
    ),
  )

const main = (
  modulePath === undefined
    ? Effect.fail<CandidateDevelopmentCommandFailure>({ _tag: 'CandidateDevelopmentCommandModulePathMissing' })
    : loadCandidateDevelopmentExecutableProgram(modulePath).pipe(
        Effect.flatMap(executeLoadedCandidateDevelopmentProgram),
      )
).pipe(Effect.annotateLogs({ operation: 'candidate-development-command' }))

class CandidateDevelopmentCommandError extends Data.TaggedError('CandidateDevelopmentCommandError')<{
  readonly failure: CandidateDevelopmentCommandFailure
}> {}

if (import.meta.main) {
  NodeRuntime.runMain(main.pipe(Effect.mapError((failure) => new CandidateDevelopmentCommandError({ failure }))), {
    disableErrorReporting: false,
  })
}
