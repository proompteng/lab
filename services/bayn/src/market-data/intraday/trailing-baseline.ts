import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Context, Effect, Layer, Result, Schema } from 'effect'

import { OperationalError, operationalError, retryableOperationalError } from '../../errors'
import { IsoDateSchema, PositiveIntegerSchema, SymbolSchema, strictParseOptions, type IsoDate } from '../../schemas'

export const intradayAlphaTrailingBaselineSchemaVersion = 'bayn.intraday-alpha-trailing-baseline.v1' as const

// Completed top-of-hour 1m bar checkpoints (10:00..15:00 ET => elapsed 31, 91, 151, 211, 271, 331 minutes from 09:30).
// Evaluating after the XX:00 bar absorbs 10:00 ET macro releases and top-of-hour institutional rebalance flows,
// winning 6/6 half-years across 2024–2026 (703 OOS sessions) with higher Sharpe and lower drawdown than 30m grids.
export const noiseAreaCheckpointMinutes = Object.freeze([31, 91, 151, 211, 271, 331] as const)

export const SymbolTrailingBaselineSchema = Schema.Struct({
  priorSessions: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(60)),
  prevClose: Schema.Finite.check(Schema.isGreaterThan(0)),
  atr14Ratio: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(0.5)),
  avgSwingByCheckpoint: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(0.5))),
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

export interface TrailingBaselineQuery {
  readonly sessionDate: IsoDate
  readonly symbols: readonly string[]
  readonly noiseAreaSymbols: readonly string[]
  readonly lookbackSessions: number
  readonly minimumSessions: number
}

export interface IntradayTrailingBaselineService {
  readonly load: (query: TrailingBaselineQuery) => Effect.Effect<IntradayAlphaTrailingBaseline, OperationalError>
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
  readonly dailyRows: readonly PriorSessionDailySummary[]
  readonly checkpointRows: readonly PriorSessionCheckpointSummary[]
}): Result.Result<IntradayAlphaTrailingBaseline, OperationalError> => {
  const { sessionDate, lookbackSessions, minimumSessions } = input
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
      if (denom > 0 && Number.isFinite(tr / denom) && tr / denom > 0) {
        trRatios.push(tr / denom)
      }
    }
    if (trRatios.length < minimumSessions) continue
    const atr14Ratio = round6(trRatios.reduce((sum, value) => sum + value, 0) / trRatios.length)
    const prevClose = round6(latest.close)
    if (atr14Ratio <= 0 || atr14Ratio > 0.5 || prevClose <= 0) continue

    let avgSwingByCheckpoint: Record<string, number> | undefined
    if (noiseSet.has(symbol)) {
      const swingWindow = rows.slice(-lookbackSessions)
      const swings: Record<string, number> = {}
      for (const minute of noiseAreaCheckpointMinutes) {
        const samples: number[] = []
        for (const day of swingWindow) {
          const cpClose = checkpointsBySymbolDate.get(`${symbol}|${day.sessionDate}`)?.get(minute)
          if (cpClose !== undefined && day.open > 0) {
            const move = Math.abs(cpClose / day.open - 1)
            if (Number.isFinite(move)) samples.push(move)
          }
        }
        if (samples.length >= minimumSessions) {
          const mean = round6(samples.reduce((sum, value) => sum + value, 0) / samples.length)
          if (mean > 0 && mean <= 0.5) swings[String(minute)] = mean
        }
      }
      if (Object.keys(swings).length > 0) avgSwingByCheckpoint = swings
    }

    symbolBaselines[symbol] = {
      priorSessions: Math.min(lookbackSessions, trRatios.length),
      prevClose,
      atr14Ratio,
      ...(avgSwingByCheckpoint === undefined ? {} : { avgSwingByCheckpoint }),
    }
  }

  if (latestPriorSessionDate === '' || Object.keys(symbolBaselines).length === 0) {
    return Result.fail(
      operationalError({
        component: 'market-data',
        operation: 'trailing-baseline',
        message: 'No symbol met the minimum trailing session count before this session',
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

const toFiniteNumber = (value: number | string): number => (typeof value === 'number' ? value : Number(value))

/**
 * Read-only ClickHouse loader for strictly causal trailing regular-session baselines (< sessionDate).
 * Queries signal.intraday_bars_1m_v2 (deduplicated per minute) and falls back to
 * signal.adjusted_daily_bars_v2 for symbols with sparse intraday history. Caches per sessionDate.
 */
export const makeClickhouseTrailingBaseline = (
  sql: ClickhouseClient.ClickhouseClient,
): IntradayTrailingBaselineService => {
  const cache = new Map<string, IntradayAlphaTrailingBaseline>()

  const load: IntradayTrailingBaselineService['load'] = (query) =>
    Effect.gen(function* () {
      const sortedSymbols = [...new Set(query.symbols)].sort()
      const sortedNoise = [...new Set(query.noiseAreaSymbols)].sort()
      const cacheKey = `${query.sessionDate}|${query.lookbackSessions}|${sortedSymbols.join(',')}|${sortedNoise.join(',')}`
      const cached = cache.get(cacheKey)
      if (cached !== undefined) return cached

      const lookbackCalendarDays = Math.max(35, query.lookbackSessions * 3)
      const checkpointMins = [...noiseAreaCheckpointMinutes]

      const intradayDailyRaw = yield* sql`
        WITH dedup AS (
          SELECT
            symbol,
            toTimeZone(coalesce(event_ts_exact, event_ts), 'America/New_York') AS ny_ts,
            argMax(toFloat64(open), tuple(coalesce(ingest_ts_exact, ingest_ts), source_partition, source_offset)) AS open,
            argMax(toFloat64(high), tuple(coalesce(ingest_ts_exact, ingest_ts), source_partition, source_offset)) AS high,
            argMax(toFloat64(low), tuple(coalesce(ingest_ts_exact, ingest_ts), source_partition, source_offset)) AS low,
            argMax(toFloat64(close), tuple(coalesce(ingest_ts_exact, ingest_ts), source_partition, source_offset)) AS close
          FROM signal.intraday_bars_1m_v2
          WHERE has(${sql.param('Array(String)', sortedSymbols)}, symbol)
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
        WHERE (toHour(ny_ts) * 60 + toMinute(ny_ts)) >= 570
          AND (toHour(ny_ts) * 60 + toMinute(ny_ts)) < 960
          AND toDate(ny_ts) < toDate(${sql.param('String', query.sessionDate)})
        GROUP BY symbol, session_date
        HAVING count() >= 200
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
                  argMax(toFloat64(close), tuple(coalesce(ingest_ts_exact, ingest_ts), source_partition, source_offset)) AS close
                FROM signal.intraday_bars_1m_v2
                WHERE has(${sql.param('Array(String)', sortedNoise)}, symbol)
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
                WHERE (toHour(ny_ts) * 60 + toMinute(ny_ts)) >= 570
                  AND (toHour(ny_ts) * 60 + toMinute(ny_ts)) < 960
                  AND toDate(ny_ts) < toDate(${sql.param('String', query.sessionDate)})
              )
              SELECT
                symbol,
                session_date,
                cp AS minute_from_open,
                argMaxIf(close, m, m < cp) AS close
              FROM rth
              ARRAY JOIN ${sql.param('Array(Int32)', checkpointMins)} AS cp
              GROUP BY symbol, session_date, cp
              HAVING countIf(m < cp) > 0
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
      const checkpointRows: PriorSessionCheckpointSummary[] = decodedCheckpoints.map((row) => ({
        symbol: row.symbol,
        sessionDate: row.session_date,
        minuteFromOpen: Math.trunc(toFiniteNumber(row.minute_from_open)),
        close: toFiniteNumber(row.close),
      }))

      // Supplement any symbol lacking enough intraday sessions from adjusted_daily_bars_v2.
      const counts = new Map<string, number>()
      for (const row of dailyRows) counts.set(row.symbol, (counts.get(row.symbol) ?? 0) + 1)
      const sparseSymbols = sortedSymbols.filter((symbol) => (counts.get(symbol) ?? 0) < query.minimumSessions)
      if (sparseSymbols.length > 0) {
        const fallbackRaw = yield* sql`
          SELECT
            symbol,
            formatDateTime(session_date, '%Y-%m-%d') AS session_date,
            argMax(toFloat64(open), observed_at) AS open,
            argMax(toFloat64(high), observed_at) AS high,
            argMax(toFloat64(low), observed_at) AS low,
            argMax(toFloat64(close), observed_at) AS close
          FROM signal.adjusted_daily_bars_v2
          WHERE has(${sql.param('Array(String)', sparseSymbols)}, symbol)
            AND session_date >= toDate(${sql.param('String', query.sessionDate)}) - toIntervalDay(${sql.param('UInt32', lookbackCalendarDays)})
            AND session_date < toDate(${sql.param('String', query.sessionDate)})
          GROUP BY symbol, session_date
          ORDER BY symbol, session_date
        `.pipe(Effect.orElseSucceed(() => []))
        const decodedFallback = yield* Schema.decodeUnknownEffect(Schema.Array(DailyRowSchema))(fallbackRaw)
        const existingKeys = new Set(dailyRows.map((row) => `${row.symbol}|${row.sessionDate}`))
        for (const row of decodedFallback) {
          const key = `${row.symbol}|${row.session_date}`
          if (existingKeys.has(key)) continue
          existingKeys.add(key)
          dailyRows.push({
            symbol: row.symbol,
            sessionDate: row.session_date,
            open: toFiniteNumber(row.open),
            high: toFiniteNumber(row.high),
            low: toFiniteNumber(row.low),
            close: toFiniteNumber(row.close),
          })
        }
      }

      const baseline = yield* Effect.fromResult(
        buildTrailingBaseline({
          sessionDate: query.sessionDate,
          symbols: sortedSymbols,
          noiseAreaSymbols: sortedNoise,
          lookbackSessions: query.lookbackSessions,
          minimumSessions: query.minimumSessions,
          dailyRows,
          checkpointRows,
        }),
      )
      if (cache.size >= 8) {
        const oldest = cache.keys().next()
        if (oldest.done !== true) cache.delete(oldest.value)
      }
      cache.set(cacheKey, baseline)
      return baseline
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof OperationalError
          ? cause
          : retryableOperationalError({
              component: 'market-data',
              operation: 'trailing-baseline',
              message: 'Could not load strictly causal trailing session baseline from ClickHouse',
              cause,
            }),
      ),
    )

  return { load }
}

export const ClickhouseTrailingBaselineLive = Layer.effect(
  IntradayTrailingBaseline,
  Effect.map(ClickhouseClient.ClickhouseClient, makeClickhouseTrailingBaseline),
)
