import { expect, test } from 'bun:test'
import type { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Exit, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { IsoDateSchema } from '../../schemas'
import { preparedAlphaBaselineFixture } from '../../observe-composition/alpha-baseline-preparation.test-support'
import { reproduceTrailingBaselineAcquisition } from './baseline-acquisition'
import {
  buildTrailingBaseline,
  intradayAlphaTrailingBaselineSchemaVersion,
  makeClickhouseTrailingBaseline,
  noiseAreaCheckpointMinutes,
  trailingBaselineCoversQuery,
  TrailingBaselinePendingCoverage,
  type PriorSessionCheckpointSummary,
  type PriorSessionDailySummary,
} from './trailing-baseline'

const iso = (date: string) => Schema.decodeUnknownSync(IsoDateSchema)(date)

test('buildTrailingBaseline enforces strict causality and rejects same-day or future rows', () => {
  const dailyRows: PriorSessionDailySummary[] = [
    { symbol: 'QQQ', sessionDate: iso('2026-09-01'), open: 500, high: 505, low: 498, close: 503 },
    { symbol: 'QQQ', sessionDate: iso('2026-09-02'), open: 503, high: 508, low: 501, close: 506 },
    { symbol: 'QQQ', sessionDate: iso('2026-09-03'), open: 506, high: 510, low: 504, close: 508 },
    { symbol: 'QQQ', sessionDate: iso('2026-09-04'), open: 508, high: 512, low: 506, close: 510 },
    { symbol: 'QQQ', sessionDate: iso('2026-09-08'), open: 510, high: 515, low: 508, close: 512 },
  ]
  const leaky = buildTrailingBaseline({
    sessionDate: iso('2026-09-08'),
    symbols: ['QQQ'],
    noiseAreaSymbols: ['QQQ'],
    lookbackSessions: 14,
    minimumSessions: 5,
    dailyRows,
    checkpointRows: [],
  })
  expect(Result.isFailure(leaky)).toBe(true)

  const leakyCheckpoint = buildTrailingBaseline({
    sessionDate: iso('2026-09-09'),
    symbols: ['QQQ'],
    noiseAreaSymbols: ['QQQ'],
    lookbackSessions: 14,
    minimumSessions: 5,
    dailyRows,
    checkpointRows: [{ symbol: 'QQQ', sessionDate: iso('2026-09-09'), minuteFromOpen: 31, close: 515 }],
  })
  expect(Result.isFailure(leakyCheckpoint)).toBe(true)
})

type CoverageMode = 'complete' | 'one-symbol' | 'missing-checkpoint' | 'empty'

const preparationLoaderFixture = (initial: CoverageMode) => {
  const source = preparedAlphaBaselineFixture().payload.acquisition
  let mode = initial
  let readCount = 0
  let finishReadAt: string | undefined
  const sql = Object.assign(
    (strings: TemplateStringsArray) => {
      const query = strings.join('?')
      readCount++
      if (query.includes('FROM signal.intraday_bars_1m_v2') && query.includes('ARRAY JOIN'))
        return Effect.succeed(
          source.inputs.checkpointRows
            .filter(
              (row) =>
                mode === 'complete' ||
                (mode === 'missing-checkpoint' && !(row.symbol === 'QQQ' && row.minuteFromOpen === 31)),
            )
            .map((row) => ({
              symbol: row.symbol,
              session_date: row.sessionDate,
              minute_from_open: row.minuteFromOpen,
              close: row.close,
            })),
        )
      if (query.includes('FROM signal.intraday_bars_1m_v2'))
        return Effect.gen(function* () {
          if (finishReadAt !== undefined) yield* TestClock.setTime(Date.parse(finishReadAt))
          return source.inputs.intradayDailyRows
            .filter(
              (row) =>
                mode === 'complete' ||
                mode === 'missing-checkpoint' ||
                (mode === 'one-symbol' && row.symbol === 'AAPL'),
            )
            .map((row) => ({
              symbol: row.symbol,
              session_date: row.sessionDate,
              open: row.open,
              high: row.high,
              low: row.low,
              close: row.close,
            }))
        })
      return Effect.succeed([])
    },
    { param: (type: string, value: unknown) => ({ type, value }) },
  ) as unknown as ClickhouseClient.ClickhouseClient
  const service = makeClickhouseTrailingBaseline(sql)
  const acquire = service.acquire
  if (acquire === undefined) throw new Error('Missing native acquisition')
  return {
    service,
    acquire,
    query: source.query,
    window: { regularOpenAt: '2026-09-04T13:30:00.000Z' },
    reads: () => readCount,
    change: (next: CoverageMode) => {
      mode = next
    },
    finishAt: (at: string | undefined) => {
      finishReadAt = at
    },
  }
}

test('incomplete preopen symbol, checkpoint and empty coverage stay pending without caching later inputs', async () => {
  for (const mode of ['one-symbol', 'missing-checkpoint', 'empty'] as const) {
    const f = preparationLoaderFixture(mode)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-09-04T12:01:02.000Z'))
        const pending = yield* f.acquire(f.query, f.window).pipe(Effect.result)
        expect(Result.isFailure(pending)).toBe(true)
        if (Result.isFailure(pending)) expect(pending.failure).toBeInstanceOf(TrailingBaselinePendingCoverage)
        const earlyReads = f.reads()
        f.change('complete')
        yield* TestClock.setTime(Date.parse('2026-09-04T13:31:02.000Z'))
        const regular = yield* f.acquire(f.query, f.window)
        expect(f.reads()).toBeGreaterThan(earlyReads)
        expect(regular.startedAt).toBe('2026-09-04T13:31:02.000Z')
        expect(trailingBaselineCoversQuery(f.query, regular.trailingBaseline)).toBe(true)
        expect(Result.getOrThrow(reproduceTrailingBaselineAcquisition(regular))).toEqual(regular)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  }
})

test('complete preopen acquisition is reused with original clocks while regular partial coverage remains allowed', async () => {
  for (const initial of ['complete', 'one-symbol'] as const) {
    const f = preparationLoaderFixture(initial)
    await Effect.runPromise(
      Effect.gen(function* () {
        const startedAt = initial === 'complete' ? '2026-09-04T12:01:02.000Z' : f.window.regularOpenAt
        yield* TestClock.setTime(Date.parse(startedAt))
        const first = yield* f.acquire(f.query, f.window)
        expect(trailingBaselineCoversQuery(f.query, first.trailingBaseline)).toBe(initial === 'complete')
        const reads = f.reads()
        f.change(initial === 'complete' ? 'one-symbol' : 'complete')
        yield* TestClock.setTime(Date.parse('2026-09-04T13:31:02.000Z'))
        const reused = yield* f.acquire(f.query, f.window)
        expect(reused).toEqual(first)
        expect(reused.startedAt).toBe(startedAt)
        expect(f.reads()).toBe(reads)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  }
})

test('a partial query begun preopen cannot become regular by finishing later or by reusing an old cache entry', async () => {
  const crossing = preparationLoaderFixture('one-symbol')
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-09-04T13:29:59.000Z'))
      crossing.finishAt('2026-09-04T13:30:01.000Z')
      const pending = yield* crossing.acquire(crossing.query, crossing.window).pipe(Effect.result)
      expect(Result.isFailure(pending)).toBe(true)
      if (Result.isFailure(pending)) expect(pending.failure).toBeInstanceOf(TrailingBaselinePendingCoverage)
      const firstReads = crossing.reads()
      crossing.finishAt(undefined)
      yield* TestClock.setTime(Date.parse('2026-09-04T13:31:02.000Z'))
      const regular = yield* crossing.acquire(crossing.query, crossing.window)
      expect(regular.startedAt).toBe('2026-09-04T13:31:02.000Z')
      expect(trailingBaselineCoversQuery(crossing.query, regular.trailingBaseline)).toBe(false)
      expect(crossing.reads()).toBeGreaterThan(firstReads)
    }).pipe(Effect.provide(TestClock.layer())),
  )

  const cached = preparationLoaderFixture('one-symbol')
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse('2026-09-04T12:01:02.000Z'))
      const legacy = yield* cached.service.load(cached.query)
      expect(trailingBaselineCoversQuery(cached.query, legacy)).toBe(false)
      const earlyReads = cached.reads()
      yield* TestClock.setTime(Date.parse('2026-09-04T13:31:02.000Z'))
      const acquired = yield* cached.acquire(cached.query, cached.window)
      expect(cached.reads()).toBeGreaterThan(earlyReads)
      expect(acquired.startedAt).toBe('2026-09-04T13:31:02.000Z')
      expect(acquired.trailingBaseline).toEqual(legacy)
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test('buildTrailingBaseline computes causal ATR14 True Range ratios and noise-area checkpoint swings', () => {
  const dates = ['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01', '2026-09-02']
  const dailyRows: PriorSessionDailySummary[] = []
  const checkpointRows: PriorSessionCheckpointSummary[] = []
  for (let i = 0; i < dates.length; i++) {
    const date = iso(dates[i]!)
    // QQQ: steady 1.0% intraday range around 500, +0.5% swing at checkpoint 31, -0.8% at checkpoint 91
    dailyRows.push({ symbol: 'QQQ', sessionDate: date, open: 500, high: 502.5, low: 497.5, close: 500 })
    // NVDA: 4.0% intraday range around 100
    dailyRows.push({ symbol: 'NVDA', sessionDate: date, open: 100, high: 102, low: 98, close: 100 })
    for (const cp of noiseAreaCheckpointMinutes) {
      checkpointRows.push({
        symbol: 'QQQ',
        sessionDate: date,
        minuteFromOpen: cp,
        close: cp === 31 ? 502.5 : cp === 91 ? 496 : 503,
      })
    }
  }
  const baseline = Result.getOrThrow(
    buildTrailingBaseline({
      sessionDate: iso('2026-09-03'),
      symbols: ['NVDA', 'QQQ'],
      noiseAreaSymbols: ['QQQ'],
      lookbackSessions: 14,
      minimumSessions: 5,
      dailyRows,
      checkpointRows,
    }),
  )
  expect(baseline.schemaVersion).toBe(intradayAlphaTrailingBaselineSchemaVersion)
  expect(baseline.latestPriorSessionDate).toBe(iso('2026-09-02'))
  expect(baseline.symbols['QQQ']?.priorSessions).toBe(7)
  expect(baseline.symbols['QQQ']?.prevClose).toBe(500)
  expect(baseline.symbols['QQQ']?.atr14Ratio).toBeCloseTo(0.01, 5)
  expect(baseline.symbols['QQQ']?.avgSwingByCheckpoint?.['31']).toBeCloseTo(0.005, 5)
  expect(baseline.symbols['QQQ']?.avgSwingByCheckpoint?.['91']).toBeCloseTo(0.008, 5)
  expect(baseline.symbols['NVDA']?.atr14Ratio).toBeCloseTo(0.04, 5)
  expect(baseline.symbols['NVDA']?.avgSwingByCheckpoint).toBeUndefined()
})

test('makeClickhouseTrailingBaseline binds provider/feed/source_topic/finality and uses published adjusted_daily_bars_v2 columns fail-closed', async () => {
  const executed: { readonly sql: string; readonly params: unknown[] }[] = []
  let failFallback = false
  const fakeSql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      executed.push({ sql: text, params: values })
      if (text.includes('FROM signal.intraday_bars_1m_v2') && text.includes('ARRAY JOIN')) {
        return Effect.succeed(
          ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01'].flatMap((d) =>
            noiseAreaCheckpointMinutes.map((cp) => ({
              symbol: 'QQQ',
              session_date: d,
              minute_from_open: cp,
              close: 502.5,
            })),
          ),
        )
      }
      if (text.includes('FROM signal.intraday_bars_1m_v2')) {
        // Return 5 sessions for QQQ and 1 raw pre-split session for sparse NVDA so the coherent
        // adjusted_daily_bars_v2 series replaces (rather than mixes with) raw NVDA rows.
        return Effect.succeed([
          ...['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01'].map((d) => ({
            symbol: 'QQQ',
            session_date: d,
            open: 500,
            high: 505,
            low: 495,
            close: 500,
          })),
          { symbol: 'NVDA', session_date: '2026-08-25', open: 1000, high: 1020, low: 980, close: 1000 },
        ])
      }
      if (text.includes('FROM signal.snapshot_manifests_v2')) {
        return Effect.succeed([{ snapshot_id: 'snap-2026-09-01' }])
      }
      if (text.includes('FROM signal.adjusted_daily_bars_v2')) {
        if (failFallback) return Effect.fail(new Error('clickhouse adjusted_daily unavailable'))
        return Effect.succeed(
          ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01'].map((d) => ({
            symbol: 'NVDA',
            session_date: d,
            open: 100,
            high: 103,
            low: 97,
            close: 100,
          })),
        )
      }
      return Effect.succeed([])
    },
    { param: (type: string, value: unknown) => ({ type, value }) },
  ) as unknown as ClickhouseClient.ClickhouseClient

  const service = makeClickhouseTrailingBaseline(fakeSql)
  const query = {
    sessionDate: iso('2026-09-02'),
    symbols: ['NVDA', 'QQQ'],
    noiseAreaSymbols: ['QQQ'],
    lookbackSessions: 14,
    minimumSessions: 5,
    sourceContract: {
      provider: 'alpaca',
      feed: 'iex',
      sourceTopic: 'torghut.bars.1m.v1',
      universeId: 'torghut-core-equity-v3',
    },
  } as const
  const result = await Effect.runPromise(service.load(query))
  expect(result.symbols['QQQ']?.priorSessions).toBe(5)
  expect(result.symbols['NVDA']?.priorSessions).toBe(5)
  expect(result.symbols['NVDA']?.atr14Ratio).toBeCloseTo(0.06, 5)
  if (service.acquire === undefined) throw new Error('Missing native acquisition capability')
  const queryCount = executed.length
  const acquired = await Effect.runPromise(service.acquire(query))
  expect(executed).toHaveLength(queryCount)
  expect(acquired.trailingBaseline).toEqual(result)
  expect(Result.getOrThrow(reproduceTrailingBaselineAcquisition(acquired))).toEqual(acquired)
  expect(acquired.inputs.intradayDailyRows.find((row) => row.symbol === 'NVDA')?.close).toBe(1000)
  expect(acquired.inputs.adjustedDailyFallback?.snapshotId).toBe('snap-2026-09-01')
  expect(acquired.inputs.adjustedDailyFallback?.dailyRows.map((row) => row.close)).toEqual([100, 100, 100, 100, 100])
  expect(acquired.completedAt >= acquired.startedAt).toBe(true)

  // Both intraday queries must bind provider, feed, source_topic, and is_final = 1 before deduplication.
  const intradayQueries = executed.filter((entry) => entry.sql.includes('FROM signal.intraday_bars_1m_v2'))
  expect(intradayQueries).toHaveLength(2)
  for (const entry of intradayQueries) {
    expect(entry.sql).toContain('provider =')
    expect(entry.sql).toContain('feed =')
    expect(entry.sql).toContain('source_topic =')
    expect(entry.sql).toContain('is_final = 1')
  }
  const fallbackQuery = executed.find((entry) => entry.sql.includes('FROM signal.adjusted_daily_bars_v2'))
  expect(fallbackQuery?.sql).toContain('adjusted_open')
  expect(fallbackQuery?.sql).toContain('adjusted_high')
  expect(fallbackQuery?.sql).toContain('adjusted_low')
  expect(fallbackQuery?.sql).toContain('adjusted_close')
  expect(fallbackQuery?.sql).toContain('snapshot_id =')

  // Fallback ClickHouse errors must propagate fail-closed rather than being silently suppressed.
  failFallback = true
  const failed = await Effect.runPromiseExit(service.load({ ...query, sessionDate: iso('2026-09-03') }))
  expect(Exit.isFailure(failed)).toBe(true)
})

test('pure-ETF ClickHouse daily summary query requires session-length-aware minimum bar coverage in addition to endpoints', async () => {
  const executed: { readonly sql: string; readonly params: unknown[] }[] = []
  const dates = ['2026-08-26', '2026-08-27', '2026-08-28', '2026-08-31', '2026-09-01']
  const fakeSql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      executed.push({ sql: text, params: values })
      if (text.includes('FROM signal.intraday_bars_1m_v2') && text.includes('ARRAY JOIN')) {
        return Effect.succeed(
          dates.flatMap((d) =>
            [30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((cp) => ({
              symbol: 'QQQ',
              session_date: d,
              minute_from_open: cp,
              close: 502.5,
            })),
          ),
        )
      }
      if (text.includes('FROM signal.intraday_bars_1m_v2')) {
        return Effect.succeed(
          dates.map((d) => ({
            symbol: 'QQQ',
            session_date: d,
            open: 500,
            high: 505,
            low: 495,
            close: 500,
          })),
        )
      }
      return Effect.succeed([])
    },
    { param: (type: string, value: unknown) => ({ type, value }) },
  ) as unknown as ClickhouseClient.ClickhouseClient

  const service = makeClickhouseTrailingBaseline(fakeSql)
  const acquire = service.acquire
  if (acquire === undefined) throw new Error('Missing native acquisition')
  await Effect.runPromise(
    acquire(
      {
        sessionDate: iso('2026-09-02'),
        symbols: ['QQQ'],
        noiseAreaSymbols: ['QQQ'],
        lookbackSessions: 4,
        minimumSessions: 4,
        checkpointMinutesFromOpen: [30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330],
        sourceContract: {
          provider: 'alpaca',
          feed: 'iex',
          sourceTopic: 'torghut.bars.1m.v1',
          universeId: 'torghut-core-equity-v3',
        },
      },
      {
        regularOpenAt: '2026-09-02T13:30:00.000Z',
        loadHistorySessions: Effect.succeed(
          dates.map((date, index) => ({
            date: iso(date),
            openAt: `${date}T13:30:00.000Z`,
            closeAt: index === 0 ? `${date}T17:00:00.000Z` : `${date}T20:00:00.000Z`,
          })),
        ),
      },
    ),
  )

  const coverageFragment = executed.find((entry) =>
    entry.sql.includes('tuple(toUnixTimestamp(min(ny_ts)), toUnixTimestamp(max(ny_ts)) + 60)'),
  )
  expect(coverageFragment).toBeDefined()
  expect(coverageFragment?.sql).toContain(
    'count() * 390 * 60 >= 200 * (toUnixTimestamp(max(ny_ts)) + 60 - toUnixTimestamp(min(ny_ts)))',
  )
})
