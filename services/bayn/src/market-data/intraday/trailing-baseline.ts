import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Context, Data, Effect, Layer, Result, Schema } from 'effect'

import { OperationalError, operationalError, retryableOperationalError } from '../../errors'
import {
  IsoDateSchema,
  PositiveIntegerSchema,
  SymbolSchema,
  UtcInstantSchema,
  strictParseOptions,
  type IsoDate,
} from '../../schemas'
import { currentUtcInstant } from '../../time'
import { MarketCalendarObservationSchema } from '../../broker/alpaca/model'
import type { TrailingBaselineAcquisition } from './baseline-acquisition'

export const intradayAlphaTrailingBaselineSchemaVersion = 'bayn.intraday-alpha-trailing-baseline.v1' as const

// Completed top-of-hour 1m bar checkpoints (10:00..15:00 ET => elapsed 31, 91, 151, 211, 271, 331 minutes from 09:30).
// This grid adapts the noise-area hypothesis to Bayn's ETF sleeve; its profitability and out-of-sample status
// require retained, reproducible validation with documented model-selection chronology.
export const noiseAreaCheckpointMinutes = Object.freeze([31, 91, 151, 211, 271, 331] as const)

export const pureEtfCheckpointMinutes = Object.freeze([30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] as const)

export const SymbolTrailingBaselineSchema = Schema.Struct({
  priorSessions: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60)),
  prevClose: Schema.Finite.check(Schema.isGreaterThan(0)),
  atr14Ratio: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(0.5)),
  sessionVolatility: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  avgSwingByCheckpoint: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(0.5)),
    ),
  ),
})
export type SymbolTrailingBaseline = typeof SymbolTrailingBaselineSchema.Type

export const IntradayAlphaTrailingBaselineSchema = Schema.Struct({
  schemaVersion: Schema.Literal(intradayAlphaTrailingBaselineSchemaVersion),
  sessionDate: IsoDateSchema,
  lookbackSessions: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60)),
  latestPriorSessionDate: IsoDateSchema,
  symbols: Schema.Record(SymbolSchema, SymbolTrailingBaselineSchema),
}).check(
  Schema.makeFilter((baseline) =>
    baseline.latestPriorSessionDate < baseline.sessionDate
      ? []
      : [
          {
            path: ['latestPriorSessionDate'],
            issue: 'trailing baseline must strictly precede the trading session date',
          },
        ],
  ),
)
export type IntradayAlphaTrailingBaseline = typeof IntradayAlphaTrailingBaselineSchema.Type

export interface PriorSessionDailySummary {
  readonly symbol: string
  readonly sessionDate: IsoDate
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
}

export interface PriorSessionCheckpointSummary {
  readonly symbol: string
  readonly sessionDate: IsoDate
  readonly minuteFromOpen: number
  readonly close: number
}

export interface TrailingBaselineSourceContract {
  readonly provider: string
  readonly feed: string
  readonly sourceTopic: string
  readonly universeId?: string
}

export interface TrailingBaselineQuery {
  readonly sessionDate: IsoDate
  readonly symbols: readonly string[]
  readonly noiseAreaSymbols: readonly string[]
  readonly lookbackSessions: number
  readonly minimumSessions: number
  readonly checkpointMinutesFromOpen?: readonly number[]
  readonly sourceContract: TrailingBaselineSourceContract
}

export interface TrailingBaselinePreparationWindow {
  readonly regularOpenAt: string
  readonly loadHistorySessions?: Effect.Effect<
    typeof MarketCalendarObservationSchema.fields.sessions.Type,
    OperationalError
  >
}

export class TrailingBaselinePendingCoverage extends Data.TaggedError('TrailingBaselinePendingCoverage')<{
  readonly message: string
  readonly regularOpenAt: string
}> {}

class TrailingBaselineInsufficientCoverage extends Data.TaggedError('TrailingBaselineInsufficientCoverage')<{
  readonly sessionDate: IsoDate
  readonly minimumSessions: number
}> {}

/** Preparation readiness only; regular-session signals retain their existing per-symbol exclusions. */
export const trailingBaselineCoversQuery = (query: TrailingBaselineQuery, baseline: IntradayAlphaTrailingBaseline) =>
  query.symbols.every((symbol) => {
    const value = baseline.symbols[symbol]
    return (
      value !== undefined &&
      value.priorSessions >= query.minimumSessions &&
      Number.isFinite(value.prevClose) &&
      value.prevClose > 0 &&
      Number.isFinite(value.atr14Ratio) &&
      value.atr14Ratio > 0 &&
      value.atr14Ratio <= 0.5 &&
      (query.checkpointMinutesFromOpen === undefined || value.sessionVolatility !== undefined)
    )
  }) &&
  query.noiseAreaSymbols.every((symbol) =>
    (query.checkpointMinutesFromOpen ?? noiseAreaCheckpointMinutes).every((minute) => {
      const swing = baseline.symbols[symbol]?.avgSwingByCheckpoint?.[String(minute)]
      return (
        swing !== undefined &&
        Number.isFinite(swing) &&
        (query.checkpointMinutesFromOpen === undefined ? swing > 0 : swing >= 0) &&
        swing <= 0.5
      )
    }),
  )

export interface IntradayTrailingBaselineService {
  readonly load: (query: TrailingBaselineQuery) => Effect.Effect<IntradayAlphaTrailingBaseline, OperationalError>
  /** Native acquisition retains actual read clocks and builder inputs; replay intentionally provides only load. */
  readonly acquire?: (
    query: TrailingBaselineQuery,
    preparationWindow?: TrailingBaselinePreparationWindow,
  ) => Effect.Effect<TrailingBaselineAcquisition, OperationalError | TrailingBaselinePendingCoverage>
}

export class IntradayTrailingBaseline extends Context.Service<
  IntradayTrailingBaseline,
  IntradayTrailingBaselineService
>()('@proompteng/bayn/market-data/intraday/IntradayTrailingBaseline') {}

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000

/**
 * Pure, strictly causal 14-session baseline builder shared by live ClickHouse reads and offline replay.
 * Rejects any input row with sessionDate >= target sessionDate so future leakage is impossible.
 */
export const buildTrailingBaseline = (input: {
  readonly sessionDate: IsoDate
  readonly symbols: readonly string[]
  readonly noiseAreaSymbols: readonly string[]
  readonly lookbackSessions: number
  readonly minimumSessions: number
  readonly checkpointMinutesFromOpen?: readonly number[]
  readonly historySessions?: typeof MarketCalendarObservationSchema.fields.sessions.Type
  readonly dailyRows: readonly PriorSessionDailySummary[]
  readonly checkpointRows: readonly PriorSessionCheckpointSummary[]
}): Result.Result<IntradayAlphaTrailingBaseline, OperationalError> => {
  const { sessionDate, lookbackSessions, minimumSessions, historySessions } = input
  const pureEtf = input.checkpointMinutesFromOpen !== undefined
  const history = historySessions ?? []
  const sessions = new Map(
    history.map((session) => [session.date, (Date.parse(session.closeAt) - Date.parse(session.openAt)) / 60_000]),
  )
  if (
    pureEtf &&
    (history.length < lookbackSessions + 1 ||
      history.some(
        (session, index) =>
          session.date >= sessionDate ||
          (index > 0 && (history[index - 1]?.date ?? '') >= session.date) ||
          ![210, 390].includes(sessions.get(session.date) ?? 0),
      ))
  )
    return Result.fail(
      operationalError({
        component: 'market-data',
        operation: 'trailing-baseline',
        message: 'Pure ETF baseline requires ordered prior regular sessions',
      }),
    )
  if (
    input.dailyRows.some((row) => row.sessionDate >= sessionDate) ||
    input.checkpointRows.some((row) => row.sessionDate >= sessionDate)
  ) {
    return Result.fail(
      operationalError({
        component: 'market-data',
        operation: 'trailing-baseline',
        message: 'Trailing baseline input contains rows on or after the active session date',
      }),
    )
  }

  const dailyBySymbol = new Map<string, PriorSessionDailySummary[]>()
  for (const row of input.dailyRows) {
    if (
      !Number.isFinite(row.open) ||
      !Number.isFinite(row.high) ||
      !Number.isFinite(row.low) ||
      !Number.isFinite(row.close) ||
      row.open <= 0 ||
      row.high <= 0 ||
      row.low <= 0 ||
      row.close <= 0 ||
      row.high < row.low
    )
      continue
    const list = dailyBySymbol.get(row.symbol) ?? []
    list.push(row)
    dailyBySymbol.set(row.symbol, list)
  }

  const checkpointsBySymbolDate = new Map<string, Map<number, number>>()
  for (const row of input.checkpointRows) {
    if (!Number.isFinite(row.close) || row.close <= 0) continue
    const key = `${row.symbol}|${row.sessionDate}`
    const map = checkpointsBySymbolDate.get(key) ?? new Map<number, number>()
    map.set(row.minuteFromOpen, row.close)
    checkpointsBySymbolDate.set(key, map)
  }

  const noiseSet = new Set(input.noiseAreaSymbols)
  const symbolBaselines: Record<string, SymbolTrailingBaseline> = {}
  let latestPriorSessionDate = ''

  for (const symbol of [...new Set(input.symbols)].sort()) {
    const rows = (dailyBySymbol.get(symbol) ?? []).toSorted((a, b) => a.sessionDate.localeCompare(b.sessionDate))
    const byDate = new Map(rows.map((row) => [row.sessionDate, row]))
    if (
      pureEtf &&
      (byDate.size !== rows.length ||
        rows.some((row) => !sessions.has(row.sessionDate)) ||
        history.slice(-(lookbackSessions + 1)).some((session) => !byDate.has(session.date)))
    )
      continue
    if (rows.length < minimumSessions) continue
    // Keep lookbackSessions + 1 days so the first lookback day has a causal prior close for True Range.
    const window = rows.slice(-(lookbackSessions + 1))
    const latest = window.at(-1)
    if (latest === undefined) continue
    if (latest.sessionDate > latestPriorSessionDate) latestPriorSessionDate = latest.sessionDate

    const trRatios: number[] = []
    const trStart = window.length > lookbackSessions ? 1 : 0
    for (let index = trStart; index < window.length; index++) {
      const current = window[index]
      if (current === undefined) continue
      const prev = index > 0 ? window[index - 1] : undefined
      const tr =
        prev === undefined
          ? current.high - current.low
          : Math.max(
              current.high - current.low,
              Math.abs(current.high - prev.close),
              Math.abs(current.low - prev.close),
            )
      const denom = prev === undefined ? current.open : prev.close
      if (denom > 0 && Number.isFinite(tr / denom) && (pureEtf ? tr / denom >= 0 : tr / denom > 0)) {
        trRatios.push(tr / denom)
      }
    }
    if (trRatios.length < minimumSessions) continue
    const atr14Ratio = round6(trRatios.reduce((sum, value) => sum + value, 0) / trRatios.length)
    const returns = rows.slice(-lookbackSessions).map((day) => day.close / day.open - 1)
    const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length
    const sessionVolatility = pureEtf
      ? Math.sqrt(returns.reduce((sum, value) => sum + (value - meanReturn) ** 2, 0) / (returns.length - 1))
      : undefined
    const prevClose = round6(latest.close)
    if (atr14Ratio <= 0 || atr14Ratio > 0.5 || prevClose <= 0) continue

    let avgSwingByCheckpoint: Record<string, number> | undefined
    if (noiseSet.has(symbol)) {
      const swingWindow = rows.slice(-lookbackSessions)
      const swings: Record<string, number> = {}
      for (const minute of input.checkpointMinutesFromOpen ?? noiseAreaCheckpointMinutes) {
        const eligible = pureEtf
          ? history
              .filter((session) => (sessions.get(session.date) ?? 0) >= minute)
              .slice(-lookbackSessions)
              .flatMap((session) => {
                const row = byDate.get(session.date)
                return row === undefined ? [] : [row]
              })
          : swingWindow
        const samples: number[] = []
        for (const day of eligible) {
          const cpClose = checkpointsBySymbolDate.get(`${symbol}|${day.sessionDate}`)?.get(minute)
          if (cpClose !== undefined && day.open > 0) {
            const move = Math.abs(cpClose / day.open - 1)
            if (Number.isFinite(move)) samples.push(move)
          }
        }
        if (samples.length >= minimumSessions) {
          const mean = round6(samples.reduce((sum, value) => sum + value, 0) / samples.length)
          if ((pureEtf ? mean >= 0 : mean > 0) && mean <= 0.5) swings[String(minute)] = mean
        }
      }
      if (Object.keys(swings).length > 0) avgSwingByCheckpoint = swings
    }

    symbolBaselines[symbol] = {
      priorSessions: Math.min(lookbackSessions, trRatios.length),
      prevClose,
      atr14Ratio,
      ...(sessionVolatility === undefined ? {} : { sessionVolatility }),
      ...(avgSwingByCheckpoint === undefined ? {} : { avgSwingByCheckpoint }),
    }
  }

  if (latestPriorSessionDate === '' || Object.keys(symbolBaselines).length === 0) {
    return Result.fail(
      operationalError({
        component: 'market-data',
        operation: 'trailing-baseline',
        message: 'No symbol met the minimum trailing session count before this session',
        cause: new TrailingBaselineInsufficientCoverage({ sessionDate, minimumSessions }),
      }),
    )
  }

  return Schema.decodeUnknownResult(
    IntradayAlphaTrailingBaselineSchema,
    strictParseOptions,
  )({
    schemaVersion: intradayAlphaTrailingBaselineSchemaVersion,
    sessionDate,
    lookbackSessions,
    latestPriorSessionDate,
    symbols: symbolBaselines,
  }).pipe(
    Result.mapError((cause) =>
      operationalError({
        component: 'market-data',
        operation: 'trailing-baseline',
        message: 'Computed trailing baseline failed contract validation',
        cause,
      }),
    ),
  )
}

const DailyRowSchema = Schema.Struct({
  symbol: SymbolSchema,
  session_date: IsoDateSchema,
  open: Schema.Union([Schema.Finite, Schema.String]),
  high: Schema.Union([Schema.Finite, Schema.String]),
  low: Schema.Union([Schema.Finite, Schema.String]),
  close: Schema.Union([Schema.Finite, Schema.String]),
})

const CheckpointRowSchema = Schema.Struct({
  symbol: SymbolSchema,
  session_date: IsoDateSchema,
  minute_from_open: Schema.Union([Schema.Finite, Schema.String]),
  close: Schema.Union([Schema.Finite, Schema.String]),
})

const SnapshotIdRowSchema = Schema.Struct({
  snapshot_id: Schema.NonEmptyString,
})

const toFiniteNumber = (value: number | string): number => (typeof value === 'number' ? value : Number(value))

/**
 * Read-only ClickHouse loader for strictly causal trailing regular-session baselines (< sessionDate).
 * Queries signal.intraday_bars_1m_v2 constrained to the strategy's exact provider/feed/source_topic/final
 * contract (deduplicated per minute, prioritizing the requested universe_id on overlap dates) and
 * supplements sparse symbols from the single latest published snapshot in signal.adjusted_daily_bars_v2.
 */
export const makeClickhouseTrailingBaseline = (
  sql: ClickhouseClient.ClickhouseClient,
): IntradayTrailingBaselineService => {
  const cache = new Map<string, TrailingBaselineAcquisition>()

  function acquire(query: TrailingBaselineQuery): Effect.Effect<TrailingBaselineAcquisition, OperationalError>
  function acquire(
    query: TrailingBaselineQuery,
    preparationWindow?: TrailingBaselinePreparationWindow,
  ): Effect.Effect<TrailingBaselineAcquisition, OperationalError | TrailingBaselinePendingCoverage>
  function acquire(
    query: TrailingBaselineQuery,
    preparationWindow?: TrailingBaselinePreparationWindow,
  ): Effect.Effect<TrailingBaselineAcquisition, OperationalError | TrailingBaselinePendingCoverage> {
    return Effect.gen(function* () {
      const regularOpenAt =
        preparationWindow === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(UtcInstantSchema, strictParseOptions)(preparationWindow.regularOpenAt)
      const sortedSymbols = [...new Set(query.symbols)].sort()
      const sortedNoise = [...new Set(query.noiseAreaSymbols)].sort()
      const { provider, feed, sourceTopic, universeId } = query.sourceContract
      const cacheKey = `${query.sessionDate}|${query.lookbackSessions}|${query.minimumSessions}|${provider}|${feed}|${sourceTopic}|${universeId ?? ''}|${sortedSymbols.join(',')}|${sortedNoise.join(',')}|${query.checkpointMinutesFromOpen?.join(',') ?? ''}`
      const cached = cache.get(cacheKey)
      if (cached !== undefined) {
        if (
          regularOpenAt === undefined ||
          cached.startedAt >= regularOpenAt ||
          trailingBaselineCoversQuery(query, cached.trailingBaseline)
        )
          return cached
        // An earlier legacy load may have cached partial coverage. Its original query time never becomes regular.
        cache.delete(cacheKey)
      }
      if (provider !== 'alpaca' || feed !== 'iex' || universeId === undefined)
        return yield* operationalError({
          component: 'market-data',
          operation: 'trailing-baseline',
          message: 'Native alpha acquisition requires its exact Alpaca IEX universe source contract',
        })
      const startedAt = yield* currentUtcInstant

      const pureEtf = query.checkpointMinutesFromOpen !== undefined
      const historySessions =
        pureEtf && preparationWindow?.loadHistorySessions !== undefined
          ? yield* preparationWindow.loadHistorySessions
          : undefined
      if (pureEtf && historySessions === undefined)
        return yield* operationalError({
          component: 'market-data',
          operation: 'trailing-baseline',
          message: 'Pure ETF history requires the provider regular-session calendar',
        })
      const lookbackCalendarDays = Math.max(35, query.lookbackSessions * 3)
      const checkpointMins =
        query.checkpointMinutesFromOpen === undefined ? [...noiseAreaCheckpointMinutes] : [...pureEtfCheckpointMinutes]
      const regularSessions = (historySessions ?? []).map((session) => [
        Date.parse(session.openAt) / 1000,
        Date.parse(session.closeAt) / 1000,
      ])
      const regularBar =
        historySessions === undefined
          ? sql`(toHour(ny_ts) * 60 + toMinute(ny_ts)) >= 570 AND (toHour(ny_ts) * 60 + toMinute(ny_ts)) < 960`
          : sql`arrayExists(s -> toUnixTimestamp(ny_ts) >= s.1 AND toUnixTimestamp(ny_ts) < s.2,
                ${sql.param('Array(Tuple(UInt32, UInt32))', regularSessions)})`
      const exactUniverse = pureEtf ? sql`AND universe_id = ${sql.param('String', universeId)}` : sql``
      const dailyCoverage =
        historySessions === undefined
          ? sql`count() >= 200`
          : sql`has(${sql.param('Array(Tuple(UInt32, UInt32))', regularSessions)},
              tuple(toUnixTimestamp(min(ny_ts)), toUnixTimestamp(max(ny_ts)) + 60))
            AND count() * 390 * 60 >= 200 * (toUnixTimestamp(max(ny_ts)) + 60 - toUnixTimestamp(min(ny_ts)))`
      const checkpointBar = pureEtf ? sql`m = cp - 1` : sql`m < cp`
      const preferredUniverse = universeId ?? ''

      const intradayDailyRaw = yield* sql`
        WITH dedup AS (
          SELECT
            symbol,
            toTimeZone(coalesce(event_ts_exact, event_ts), 'America/New_York') AS ny_ts,
            argMax(toFloat64(open), tuple(universe_id = ${sql.param('String', preferredUniverse)}, coalesce(ingest_ts_exact, ingest_ts), source_partition, source_offset)) AS open,
            argMax(toFloat64(high), tuple(universe_id = ${sql.param('String', preferredUniverse)}, coalesce(ingest_ts_exact, ingest_ts), source_partition, source_offset)) AS high,
            argMax(toFloat64(low), tuple(universe_id = ${sql.param('String', preferredUniverse)}, coalesce(ingest_ts_exact, ingest_ts), source_partition, source_offset)) AS low,
            argMax(toFloat64(close), tuple(universe_id = ${sql.param('String', preferredUniverse)}, coalesce(ingest_ts_exact, ingest_ts), source_partition, source_offset)) AS close
          FROM signal.intraday_bars_1m_v2
          WHERE provider = ${sql.param('String', provider)}
            AND feed = ${sql.param('String', feed)}
            AND source_topic = ${sql.param('String', sourceTopic)}
            ${exactUniverse}
            AND is_final = 1
            AND has(${sql.param('Array(String)', sortedSymbols)}, symbol)
            AND event_ts >= parseDateTime64BestEffort(${sql.param('String', `${query.sessionDate}T00:00:00Z`)}, 3, 'UTC') - toIntervalDay(${sql.param('UInt32', lookbackCalendarDays)})
            AND event_ts < parseDateTime64BestEffort(${sql.param('String', `${query.sessionDate}T00:00:00Z`)}, 3, 'UTC')
          GROUP BY symbol, coalesce(event_ts_exact, event_ts)
        )
        SELECT
          symbol,
          formatDateTime(toDate(ny_ts), '%Y-%m-%d') AS session_date,
          argMin(open, ny_ts) AS open,
          max(high) AS high,
          min(low) AS low,
          argMax(close, ny_ts) AS close
        FROM dedup
        WHERE ${regularBar}
          AND toDate(ny_ts) < toDate(${sql.param('String', query.sessionDate)})
        GROUP BY symbol, session_date
        HAVING ${dailyCoverage}
        ORDER BY symbol, session_date
      `

      const checkpointRaw =
        sortedNoise.length === 0
          ? []
          : yield* sql`
              WITH dedup AS (
                SELECT
                  symbol,
                  toTimeZone(coalesce(event_ts_exact, event_ts), 'America/New_York') AS ny_ts,
                  argMax(toFloat64(close), tuple(universe_id = ${sql.param('String', preferredUniverse)}, coalesce(ingest_ts_exact, ingest_ts), source_partition, source_offset)) AS close
                FROM signal.intraday_bars_1m_v2
                WHERE provider = ${sql.param('String', provider)}
                  AND feed = ${sql.param('String', feed)}
                  AND source_topic = ${sql.param('String', sourceTopic)}
                  ${exactUniverse}
                  AND is_final = 1
                  AND has(${sql.param('Array(String)', sortedNoise)}, symbol)
                  AND event_ts >= parseDateTime64BestEffort(${sql.param('String', `${query.sessionDate}T00:00:00Z`)}, 3, 'UTC') - toIntervalDay(${sql.param('UInt32', lookbackCalendarDays)})
                  AND event_ts < parseDateTime64BestEffort(${sql.param('String', `${query.sessionDate}T00:00:00Z`)}, 3, 'UTC')
                GROUP BY symbol, coalesce(event_ts_exact, event_ts)
              ),
              rth AS (
                SELECT
                  symbol,
                  formatDateTime(toDate(ny_ts), '%Y-%m-%d') AS session_date,
                  (toHour(ny_ts) * 60 + toMinute(ny_ts)) - 570 AS m,
                  close
                FROM dedup
                WHERE ${regularBar}
                  AND toDate(ny_ts) < toDate(${sql.param('String', query.sessionDate)})
              )
              SELECT
                symbol,
                session_date,
                cp AS minute_from_open,
                argMaxIf(close, m, ${checkpointBar}) AS close
              FROM rth
              ARRAY JOIN ${sql.param('Array(Int32)', checkpointMins)} AS cp
              GROUP BY symbol, session_date, cp
              HAVING countIf(${checkpointBar}) > 0
              ORDER BY symbol, session_date, cp
            `

      const decodedDaily = yield* Schema.decodeUnknownEffect(Schema.Array(DailyRowSchema))(intradayDailyRaw)
      const decodedCheckpoints = yield* Schema.decodeUnknownEffect(Schema.Array(CheckpointRowSchema))(checkpointRaw)

      const dailyRows: PriorSessionDailySummary[] = decodedDaily.map((row) => ({
        symbol: row.symbol,
        sessionDate: row.session_date,
        open: toFiniteNumber(row.open),
        high: toFiniteNumber(row.high),
        low: toFiniteNumber(row.low),
        close: toFiniteNumber(row.close),
      }))
      const checkpointRows: TrailingBaselineAcquisition['inputs']['checkpointRows'] = yield* Effect.forEach(
        decodedCheckpoints,
        (row) =>
          Effect.gen(function* () {
            const minuteFromOpen = checkpointMins.find((minute) => minute === toFiniteNumber(row.minute_from_open))
            if (minuteFromOpen === undefined)
              return yield* operationalError({
                component: 'market-data',
                operation: 'trailing-baseline',
                message: 'Trailing baseline source returned an unrequested checkpoint',
              })
            return {
              symbol: row.symbol,
              sessionDate: row.session_date,
              minuteFromOpen,
              close: toFiniteNumber(row.close),
            }
          }),
      )
      const intradayDailyRows = [...dailyRows]
      let adjustedDailyFallback: TrailingBaselineAcquisition['inputs']['adjustedDailyFallback'] = null

      // Supplement any symbol lacking enough intraday sessions from the single latest coherent published
      // snapshot in signal.adjusted_daily_bars_v2 (< sessionDate) using the authoritative adjusted_* columns.
      const counts = new Map<string, number>()
      for (const row of dailyRows) counts.set(row.symbol, (counts.get(row.symbol) ?? 0) + 1)
      const sparseSymbols = sortedSymbols.filter((symbol) => (counts.get(symbol) ?? 0) < query.minimumSessions)
      if (!pureEtf && sparseSymbols.length > 0) {
        const manifestRaw = yield* sql`
          SELECT snapshot_id
          FROM signal.snapshot_manifests_v2
          WHERE provider = ${sql.param('String', provider)}
            AND adjustment = 'all'
            AND publication_asof < toDate(${sql.param('String', query.sessionDate)})
          ORDER BY publication_asof DESC, finalized_at DESC
          LIMIT 1
        `
        const manifests = yield* Schema.decodeUnknownEffect(Schema.Array(SnapshotIdRowSchema))(manifestRaw)
        const latestSnapshotId = manifests[0]?.snapshot_id
        if (latestSnapshotId !== undefined) {
          const fallbackRaw = yield* sql`
            SELECT
              symbol,
              formatDateTime(session_date, '%Y-%m-%d') AS session_date,
              toFloat64(adjusted_open) AS open,
              toFloat64(adjusted_high) AS high,
              toFloat64(adjusted_low) AS low,
              toFloat64(adjusted_close) AS close
            FROM signal.adjusted_daily_bars_v2
            WHERE snapshot_id = ${sql.param('String', latestSnapshotId)}
              AND provider = ${sql.param('String', provider)}
              AND has(${sql.param('Array(String)', sparseSymbols)}, symbol)
              AND session_date >= toDate(${sql.param('String', query.sessionDate)}) - toIntervalDay(${sql.param('UInt32', lookbackCalendarDays)})
              AND session_date < toDate(${sql.param('String', query.sessionDate)})
            ORDER BY symbol, session_date
          `
          const decodedFallback = yield* Schema.decodeUnknownEffect(Schema.Array(DailyRowSchema))(fallbackRaw)
          adjustedDailyFallback = {
            snapshotId: latestSnapshotId,
            dailyRows: decodedFallback.map((row) => ({
              symbol: row.symbol,
              sessionDate: row.session_date,
              open: toFiniteNumber(row.open),
              high: toFiniteNumber(row.high),
              low: toFiniteNumber(row.low),
              close: toFiniteNumber(row.close),
            })),
          }
          const fallbackBySymbol = new Map<string, PriorSessionDailySummary[]>()
          for (const row of decodedFallback) {
            const list = fallbackBySymbol.get(row.symbol) ?? []
            list.push({
              symbol: row.symbol,
              sessionDate: row.session_date,
              open: toFiniteNumber(row.open),
              high: toFiniteNumber(row.high),
              low: toFiniteNumber(row.low),
              close: toFiniteNumber(row.close),
            })
            fallbackBySymbol.set(row.symbol, list)
          }
          // Replace sparse symbols with a single coherent adjustment='all' daily series rather than
          // splicing raw intraday bars and adjusted daily bars across a split/dividend boundary.
          const replacedSymbols = new Set<string>()
          for (const [symbol, rows] of fallbackBySymbol) {
            if (rows.length >= query.minimumSessions) replacedSymbols.add(symbol)
          }
          if (replacedSymbols.size > 0) {
            const filtered = dailyRows.filter((row) => !replacedSymbols.has(row.symbol))
            dailyRows.length = 0
            dailyRows.push(...filtered)
            for (const symbol of replacedSymbols) {
              const rows = fallbackBySymbol.get(symbol)
              if (rows !== undefined) dailyRows.push(...rows)
            }
          }
        }
      }

      const built = buildTrailingBaseline({
        sessionDate: query.sessionDate,
        symbols: sortedSymbols,
        noiseAreaSymbols: sortedNoise,
        lookbackSessions: query.lookbackSessions,
        minimumSessions: query.minimumSessions,
        ...(query.checkpointMinutesFromOpen === undefined
          ? {}
          : { checkpointMinutesFromOpen: query.checkpointMinutesFromOpen }),
        ...(historySessions === undefined ? {} : { historySessions }),
        dailyRows,
        checkpointRows,
      })
      if (
        regularOpenAt !== undefined &&
        startedAt < regularOpenAt &&
        (Result.isSuccess(built)
          ? !trailingBaselineCoversQuery(query, built.success)
          : built.failure.cause instanceof TrailingBaselineInsufficientCoverage)
      )
        return yield* new TrailingBaselinePendingCoverage({
          message: 'Preopen baseline preparation awaits complete symbol and noise-checkpoint coverage',
          regularOpenAt,
        })
      const baseline = yield* Effect.fromResult(built)
      if (cache.size >= 8) {
        const oldest = cache.keys().next()
        if (oldest.done !== true) cache.delete(oldest.value)
      }
      const acquisition: TrailingBaselineAcquisition = {
        schemaVersion: 'bayn.intraday-alpha-baseline-acquisition.v1',
        query: {
          sessionDate: query.sessionDate,
          symbols: sortedSymbols,
          noiseAreaSymbols: sortedNoise,
          lookbackSessions: query.lookbackSessions,
          minimumSessions: query.minimumSessions,
          ...(query.checkpointMinutesFromOpen === undefined
            ? {}
            : { checkpointMinutesFromOpen: pureEtfCheckpointMinutes }),
          sourceContract: { provider, feed, sourceTopic, universeId },
        },
        startedAt,
        completedAt: yield* currentUtcInstant,
        inputs: {
          ...(historySessions === undefined ? {} : { historySessions }),
          intradayDailyRows,
          checkpointRows,
          adjustedDailyFallback,
        },
        trailingBaseline: baseline,
      }
      cache.set(cacheKey, acquisition)
      return acquisition
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof OperationalError || cause instanceof TrailingBaselinePendingCoverage
          ? cause
          : retryableOperationalError({
              component: 'market-data',
              operation: 'trailing-baseline',
              message: 'Could not load strictly causal trailing session baseline from ClickHouse',
              cause,
            }),
      ),
    )
  }

  return { load: (query) => acquire(query).pipe(Effect.map((source) => source.trailingBaseline)), acquire }
}

export const ClickhouseTrailingBaselineLive = Layer.effect(
  IntradayTrailingBaseline,
  Effect.map(ClickhouseClient.ClickhouseClient, makeClickhouseTrailingBaseline),
)
