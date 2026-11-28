import { Result, Schema } from 'effect'

import { operationalError } from '../../errors'
import { canonicalHashV1Result } from '../../hash'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../../schemas'
import {
  buildTrailingBaseline,
  IntradayAlphaTrailingBaselineSchema,
  noiseAreaCheckpointMinutes,
  type PriorSessionDailySummary,
} from './trailing-baseline'

const PriceSchema = Schema.Finite.check(Schema.isGreaterThan(0))
export const PriorSessionDailySummarySchema = Schema.Struct({
  symbol: SymbolSchema,
  sessionDate: IsoDateSchema,
  open: PriceSchema,
  high: PriceSchema,
  low: PriceSchema,
  close: PriceSchema,
})
export const PriorSessionCheckpointSummarySchema = Schema.Struct({
  symbol: SymbolSchema,
  sessionDate: IsoDateSchema,
  minuteFromOpen: Schema.Literals(noiseAreaCheckpointMinutes),
  close: PriceSchema,
})
export const TrailingBaselineQuerySchema = Schema.Struct({
  sessionDate: IsoDateSchema,
  symbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isMaxLength(24), Schema.isUnique()),
  noiseAreaSymbols: Schema.Array(SymbolSchema).check(Schema.isMaxLength(6), Schema.isUnique()),
  lookbackSessions: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60)),
  minimumSessions: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60)),
  sourceContract: Schema.Struct({
    provider: Schema.Literal('alpaca'),
    feed: Schema.Literal('iex'),
    sourceTopic: StrictNonEmptyStringSchema,
    universeId: StrictNonEmptyStringSchema,
  }),
})

/** The inputs are the actual bounded query results, including the separately identified daily fallback. */
export const TrailingBaselineAcquisitionSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-alpha-baseline-acquisition.v1'),
  query: TrailingBaselineQuerySchema,
  startedAt: UtcInstantSchema,
  completedAt: UtcInstantSchema,
  inputs: Schema.Struct({
    intradayDailyRows: Schema.Array(PriorSessionDailySummarySchema),
    checkpointRows: Schema.Array(PriorSessionCheckpointSummarySchema),
    adjustedDailyFallback: Schema.NullOr(
      Schema.Struct({
        snapshotId: StrictNonEmptyStringSchema,
        dailyRows: Schema.Array(PriorSessionDailySummarySchema),
      }),
    ),
  }),
  trailingBaseline: IntradayAlphaTrailingBaselineSchema,
})
export type TrailingBaselineAcquisition = typeof TrailingBaselineAcquisitionSchema.Type

const invalid = (message: string, cause?: unknown) =>
  Result.fail(operationalError({ component: 'market-data', operation: 'baseline-acquisition', message, cause }))

/** Preserve the existing coherent-series replacement; never splice adjusted and raw daily bars. */
export const acquiredTrailingBaselineDailyRows = (
  intraday: readonly PriorSessionDailySummary[],
  fallback: readonly PriorSessionDailySummary[],
  minimumSessions: number,
): readonly PriorSessionDailySummary[] => {
  const counts = new Map<string, number>()
  for (const row of fallback) counts.set(row.symbol, (counts.get(row.symbol) ?? 0) + 1)
  const replaced = new Set([...counts].filter(([, count]) => count >= minimumSessions).map(([symbol]) => symbol))
  return [...intraday.filter((row) => !replaced.has(row.symbol)), ...fallback.filter((row) => replaced.has(row.symbol))]
}

export const reproduceTrailingBaselineAcquisition = (raw: unknown) =>
  Result.gen(function* () {
    const source = yield* Schema.decodeUnknownResult(
      TrailingBaselineAcquisitionSchema,
      strictParseOptions,
    )(raw).pipe(
      Result.mapError((cause) =>
        operationalError({
          component: 'market-data',
          operation: 'baseline-acquisition',
          message: 'Baseline acquisition schema is invalid',
          cause,
        }),
      ),
    )
    const { query, inputs } = source
    if (
      source.completedAt < source.startedAt ||
      query.minimumSessions > query.lookbackSessions ||
      query.symbols.join('|') !== [...query.symbols].sort().join('|') ||
      query.noiseAreaSymbols.join('|') !== [...query.noiseAreaSymbols].sort().join('|') ||
      query.noiseAreaSymbols.some((symbol) => !query.symbols.includes(symbol))
    )
      return yield* invalid('Baseline acquisition clock or canonical query is invalid')
    const lowerDate = new Date(
      Date.parse(`${query.sessionDate}T00:00:00.000Z`) - Math.max(35, query.lookbackSessions * 3) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10)
    const verifyRows = (rows: readonly PriorSessionDailySummary[]) => {
      const seen = new Set<string>()
      return rows.every((row) => {
        const identity = `${row.symbol}|${row.sessionDate}`
        if (
          seen.has(identity) ||
          !query.symbols.includes(row.symbol) ||
          row.sessionDate < lowerDate ||
          row.sessionDate >= query.sessionDate ||
          row.high < row.low
        )
          return false
        seen.add(identity)
        return true
      })
    }
    const fallback = inputs.adjustedDailyFallback?.dailyRows ?? []
    if (!verifyRows(inputs.intradayDailyRows) || !verifyRows(fallback))
      return yield* invalid('Baseline acquisition repeats, substitutes or postdates its daily source rows')
    const intradayCounts = new Map<string, number>()
    for (const row of inputs.intradayDailyRows)
      intradayCounts.set(row.symbol, (intradayCounts.get(row.symbol) ?? 0) + 1)
    if (fallback.some((row) => (intradayCounts.get(row.symbol) ?? 0) >= query.minimumSessions))
      return yield* invalid('Adjusted daily fallback was supplied for a non-sparse intraday symbol')
    const checkpointIdentities = new Set<string>()
    for (const row of inputs.checkpointRows) {
      const identity = `${row.symbol}|${row.sessionDate}|${row.minuteFromOpen}`
      if (
        checkpointIdentities.has(identity) ||
        !query.noiseAreaSymbols.includes(row.symbol) ||
        row.sessionDate < lowerDate ||
        row.sessionDate >= query.sessionDate
      )
        return yield* invalid('Baseline acquisition repeats, substitutes or postdates its checkpoint source rows')
      checkpointIdentities.add(identity)
    }
    const rebuilt = yield* buildTrailingBaseline({
      ...query,
      dailyRows: acquiredTrailingBaselineDailyRows(inputs.intradayDailyRows, fallback, query.minimumSessions),
      checkpointRows: inputs.checkpointRows,
    })
    if ((yield* canonicalHashV1Result(rebuilt)) !== (yield* canonicalHashV1Result(source.trailingBaseline)))
      return yield* invalid('Baseline acquisition does not reproduce from its complete retained inputs')
    return source
  })
