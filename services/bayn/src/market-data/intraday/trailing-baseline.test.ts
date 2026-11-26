import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { IsoDateSchema } from '../../schemas'
import {
  buildTrailingBaseline,
  intradayAlphaTrailingBaselineSchemaVersion,
  noiseAreaCheckpointMinutes,
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
