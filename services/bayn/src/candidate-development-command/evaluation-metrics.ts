import { pipe, Result } from 'effect'
import { type DailyPerformancePoint } from '../evidence-contracts'
import { canonicalHashV1Result } from '../hash'
import { calculateExactPerformanceMetrics } from '../simulation/metrics'
import { type EvaluationResult, type PerformanceMetrics } from '../types'
import type { CandidateDevelopmentCommandFailure } from './contracts'

export const terminalCash = (marks: EvaluationResult['simulation']['dailyMarks']): boolean => {
  const last = marks.at(-1)
  return last !== undefined && last.positions.every((position) => position.quantityMicros === '0')
}

export type CandidateDevelopmentPerformanceSeries = readonly (DailyPerformancePoint & {
  readonly positions?: EvaluationResult['simulation']['dailyMarks'][number]['positions']
})[]

export type CandidateDevelopmentPerformanceSeriesName = Extract<
  CandidateDevelopmentCommandFailure,
  { readonly _tag: 'CandidateDevelopmentCommandPerformanceEvidenceInvalid' }
>['series']

export const performanceMetricFields = [
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

export const cumulativeMicrosFields = [
  ['turnoverMicros', 'cumulativeTurnoverMicros'],
  ['feeMicros', 'cumulativeFeesMicros'],
  ['spreadCostMicros', 'cumulativeSpreadCostMicros'],
  ['slippageCostMicros', 'cumulativeSlippageCostMicros'],
  ['cashYieldMicros', 'cumulativeCashYieldMicros'],
] as const

export interface CandidateDevelopmentPerformanceBaseline {
  readonly equityMicros: string
  readonly cumulativeTurnoverMicros: string
  readonly cumulativeFeesMicros: string
  readonly cumulativeSpreadCostMicros: string
  readonly cumulativeSlippageCostMicros: string
  readonly cumulativeCashYieldMicros: string
}

export const performanceBaselineFromPoint = (
  point: Pick<DailyPerformancePoint, keyof CandidateDevelopmentPerformanceBaseline>,
): CandidateDevelopmentPerformanceBaseline => ({
  equityMicros: point.equityMicros,
  cumulativeTurnoverMicros: point.cumulativeTurnoverMicros,
  cumulativeFeesMicros: point.cumulativeFeesMicros,
  cumulativeSpreadCostMicros: point.cumulativeSpreadCostMicros,
  cumulativeSlippageCostMicros: point.cumulativeSlippageCostMicros,
  cumulativeCashYieldMicros: point.cumulativeCashYieldMicros,
})

export const performanceEvidenceFailure = (
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

export const unsignedMicros = (
  series: CandidateDevelopmentPerformanceSeriesName,
  index: number | null,
  field: string,
  value: string,
): Result.Result<bigint, CandidateDevelopmentCommandFailure> =>
  /^(?:0|[1-9][0-9]*)$/.test(value)
    ? Result.succeed(BigInt(value))
    : Result.fail(performanceEvidenceFailure(series, 'micros-invalid', index, field, 'unsigned micros', value))

export const recomputePerformanceMetrics = (
  seriesName: CandidateDevelopmentPerformanceSeriesName,
  points: CandidateDevelopmentPerformanceSeries,
  initialCapitalMicros: string,
  selectedWindowBaseline?: CandidateDevelopmentPerformanceBaseline,
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
  const performanceBaseline = selectedWindowBaseline ?? {
    equityMicros: initialCapitalMicros,
    cumulativeTurnoverMicros: '0',
    cumulativeFeesMicros: '0',
    cumulativeSpreadCostMicros: '0',
    cumulativeSlippageCostMicros: '0',
    cumulativeCashYieldMicros: '0',
  }
  const baselineEquity = /^(?:[1-9][0-9]*)$/.test(performanceBaseline.equityMicros)
    ? Result.succeed(BigInt(performanceBaseline.equityMicros))
    : Result.fail(
        performanceEvidenceFailure(
          seriesName,
          'micros-invalid',
          null,
          'performanceBaseline.equityMicros',
          'positive micros',
          performanceBaseline.equityMicros,
        ),
      )
  if (Result.isFailure(baselineEquity)) return Result.fail(baselineEquity.failure)

  const baselineCumulative = Object.fromEntries(cumulativeMicrosFields.map(([, field]) => [field, 0n])) as Record<
    (typeof cumulativeMicrosFields)[number][1],
    bigint
  >
  for (const [, cumulativeField] of cumulativeMicrosFields) {
    const parsed = unsignedMicros(
      seriesName,
      null,
      `performanceBaseline.${cumulativeField}`,
      performanceBaseline[cumulativeField],
    )
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure)
    baselineCumulative[cumulativeField] = parsed.success
  }

  const equityMicros: bigint[] = []
  const cumulative = { ...baselineCumulative }
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
    const previousEquity = index === 0 ? baselineEquity.success : equityMicros[index - 1]
    const expectedReturn = Number(equity.success) / Number(previousEquity) - 1
    if (!Number.isFinite(expectedReturn) || !Object.is(point.netReturn, expectedReturn)) {
      return Result.fail(
        performanceEvidenceFailure(
          seriesName,
          'return-mismatch',
          index,
          'netReturn',
          Number.isFinite(expectedReturn) ? expectedReturn : 'finite return',
          point.netReturn,
        ),
      )
    }

    for (const [dailyField, cumulativeField] of cumulativeMicrosFields) {
      const daily = unsignedMicros(seriesName, index, dailyField, point[dailyField])
      if (Result.isFailure(daily)) return Result.fail(daily.failure)
      const observedCumulative = unsignedMicros(seriesName, index, cumulativeField, point[cumulativeField])
      if (Result.isFailure(observedCumulative)) return Result.fail(observedCumulative.failure)
      const prior = cumulative[cumulativeField]
      const expected = prior + daily.success
      if (observedCumulative.success !== expected) {
        return Result.fail(
          performanceEvidenceFailure(
            seriesName,
            'cumulative-mismatch',
            index,
            cumulativeField,
            expected.toString(),
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
      cumulative.cumulativeTurnoverMicros - baselineCumulative.cumulativeTurnoverMicros,
      cumulative.cumulativeFeesMicros - baselineCumulative.cumulativeFeesMicros,
      cumulative.cumulativeSpreadCostMicros - baselineCumulative.cumulativeSpreadCostMicros,
      cumulative.cumulativeSlippageCostMicros - baselineCumulative.cumulativeSlippageCostMicros,
      cumulative.cumulativeCashYieldMicros - baselineCumulative.cumulativeCashYieldMicros,
      baselineEquity.success,
    ),
    Result.mapError((cause) => performanceEvidenceFailure(seriesName, 'metrics-failed', null, null, null, null, cause)),
  )
}

export const validatePerformanceMetrics = (
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

export const validateSeriesSessions = (
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

export const markedEquityFailure = (
  reason: Extract<
    CandidateDevelopmentCommandFailure,
    { readonly _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid' }
  >['reason'],
  index: number | null,
  field: string,
  expected: unknown,
  observed: unknown,
  cause?: unknown,
): CandidateDevelopmentCommandFailure => ({
  _tag: 'CandidateDevelopmentCommandMarkedEquityInvalid',
  reason,
  index,
  field,
  expected,
  observed,
  ...(cause === undefined ? {} : { cause }),
})

export const canonicalEvidenceHash = (
  field: string,
  value: unknown,
): Result.Result<string, CandidateDevelopmentCommandFailure> =>
  pipe(
    canonicalHashV1Result(value),
    Result.mapError((cause) => markedEquityFailure('binding-mismatch', null, field, 'canonical evidence', null, cause)),
  )

export const sourceVerificationFailure = (
  operation: Extract<
    CandidateDevelopmentCommandFailure,
    { readonly _tag: 'CandidateDevelopmentCommandSourceVerificationFailed' }
  >['operation'],
  cause: unknown,
): CandidateDevelopmentCommandFailure => ({
  _tag: 'CandidateDevelopmentCommandSourceVerificationFailed',
  operation,
  cause,
})
