import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/policy'
import { runIntradayAlphaReplayVerification } from './verify-intraday-alpha-replay'

const calendar = (dates: readonly string[], close = '13:00') => ({
  query: { start: dates[0], end: dates.at(-1) },
  response: dates.map((date) => ({
    date,
    open: '09:30',
    close,
    session_open: '0400',
    session_close: '2000',
  })),
})

const rows = (date: string, minutes: number, price: (symbol: string, minute: number) => number | null) => {
  const result: string[] = []
  const openMs = Date.parse(`${date}T14:30:00.000Z`)
  for (const symbol of ['SPY', 'AAPL', 'AMD', 'AMZN', 'AVGO']) {
    for (let minute = 0; minute < minutes; minute++) {
      const close = price(symbol, minute)
      if (close === null) continue
      result.push(
        [
          symbol,
          new Date(openMs + minute * 60_000).toISOString(),
          close,
          close + 0.02,
          close - 0.02,
          close,
          1_000,
          close,
        ].join('\t'),
      )
    }
  }
  return result
}

const middayPrice = (symbol: string, minute: number) => {
  const slope = { SPY: 0, AAPL: -0.02, AMD: 0.02, AMZN: -0.01, AVGO: 0.01 }[symbol] ?? 0
  return 100 + Math.max(0, Math.min(minute, 120) - 90) * slope
}

const withRows = <A>(lines: readonly string[], run: (path: string) => A): A => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-alpha-replay-'))
  const path = join(directory, 'bars.tsv')
  try {
    writeFileSync(path, `${lines.join('\n')}\n`)
    return run(path)
  } finally {
    rmSync(directory, { recursive: true })
  }
}

test('includes a 210-minute early close and exits midday positions after 12:55 ET before 13:00 ET', () => {
  const date = '2026-11-27'
  const report = withRows(rows(date, 210, middayPrice), (path) =>
    runIntradayAlphaReplayVerification([path], calendar([date])),
  )
  expect(report.sessions).toEqual([date])
  expect(report.qualification).toBe('UNQUALIFIED')
  const scenario = report.results[0]
  expect(scenario?.totalSessions).toBe(1)
  expect(scenario?.unresolvedExits).toBe(0)
  const day = scenario?.sessionDetails[0]
  expect(day?.expectedRegularMinutes).toBe(210)
  expect(day?.benchmarkMinutes).toBe(210)
  expect(day?.trades.length).toBe(4)
  for (const trade of day?.trades ?? []) {
    expect(trade.phase).toBe(IntradayAlphaPhase.MiddayReversion)
    expect(trade.exitReason).toBe('EOD')
    expect(trade.exitAt).toBe('2026-11-27T17:56:00.000Z')
    expect(trade.exitAt > trade.entryAt).toBe(true)
  }
})

test('unfilled morning intents consume the same two attempts as durable production session history', () => {
  const date = '2026-11-27'
  const triggers: Readonly<Record<string, number>> = { AAPL: 30, AMD: 34, AMZN: 38 }
  const lines = rows(date, 210, (symbol, minute) => {
    if (symbol === 'SPY') return 100 + minute * 0.001
    const trigger = triggers[symbol]
    if (trigger === undefined || minute < trigger) return 100 + Math.min(minute, 29) * 0.001
    if (minute === trigger || symbol === 'AMZN') return 101
    return 103
  })
  const report = withRows(lines, (path) => runIntradayAlphaReplayVerification([path], calendar([date])))
  for (const scenario of report.results) {
    const morning = scenario.sessionDetails[0]?.attempts.filter(
      (attempt) => attempt.phase === IntradayAlphaPhase.MorningOrb,
    )
    expect(morning?.map((attempt) => attempt.selectedSymbols)).toEqual([['AAPL'], ['AMD']])
    expect(morning?.flatMap((attempt) => attempt.filledSymbols)).toEqual([])
    expect(scenario.sessionDetails[0]?.trades.filter((trade) => trade.phase === IntradayAlphaPhase.MorningOrb)).toEqual(
      [],
    )
  }
})

test('missing post-deadline exit prices retain unresolved inventory and withhold whole-sample P&L and Sharpe', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, (symbol, minute) =>
    symbol !== 'SPY' && minute > 205 ? null : middayPrice(symbol, minute),
  )
  const report = withRows(lines, (path) => runIntradayAlphaReplayVerification([path], calendar([date])))
  for (const scenario of report.results) {
    expect(scenario.unresolvedExits).toBe(4)
    expect(scenario.activeSessions).toBe(1)
    expect(scenario.modeledFilledLegs).toBe(4)
    expect(scenario.totalNet).toBeNull()
    expect(scenario.sharpe).toBeNull()
    expect(scenario.maxDd).toBeNull()
    expect(scenario.chronologicalSlices).toBeNull()
    expect(scenario.recentDays[0]?.modeledNet).toBeNull()
    expect(scenario.middayBasketAttribution.complete.modeledNet).toBeNull()
    expect(scenario.sessionDetails[0]?.trades).toEqual([])
    expect(scenario.sessionDetails[0]?.unresolvedExits.map((exit) => exit.exitDueAt)).toEqual([
      '2026-11-27T17:55:00.000Z',
      '2026-11-27T17:55:00.000Z',
      '2026-11-27T17:55:00.000Z',
      '2026-11-27T17:55:00.000Z',
    ])
  }
})

test('keeps calendar sessions with no captured benchmark instead of selecting only complete full days', () => {
  const dates = ['2026-11-25', '2026-11-27']
  const report = withRows(rows(dates[0] ?? '', 210, middayPrice), (path) =>
    runIntradayAlphaReplayVerification([path], calendar(dates)),
  )
  expect(report.sessions).toEqual(dates)
  const missing = report.results[0]?.sessionDetails[1]
  expect(missing?.benchmarkMinutes).toBe(0)
  expect(missing?.attempts).toEqual([])
  expect(missing?.trades).toEqual([])
})

test('reports partially filled midday baskets instead of implying planned dollar neutrality was realized', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, (symbol, minute) =>
    symbol === 'AAPL' && minute === 122 ? 101 : middayPrice(symbol, minute),
  )
  const report = withRows(lines, (path) => runIntradayAlphaReplayVerification([path], calendar([date])))
  for (const scenario of report.results) {
    expect(scenario.partiallyFilledBaskets).toBe(1)
    expect(scenario.modeledFilledLegs).toBe(3)
    expect(scenario.sessionDetails[0]?.attempts[0]?.selectedSymbols.length).toBe(4)
    expect(scenario.sessionDetails[0]?.attempts[0]?.filledSymbols).not.toContain('AAPL')
  }
})

test('uses a stop-first convention when a bar touches both stop and target and exposes the ambiguity', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, middayPrice).map((line) => {
    const fields = line.split('\t')
    if (fields[0] === 'AAPL' && fields[1] === `${date}T16:35:00.000Z`)
      return ['AAPL', fields[1], 99, 110, 90, 99, 1_000, 99].join('\t')
    return line
  })
  const report = withRows(lines, (path) => runIntradayAlphaReplayVerification([path], calendar([date])))
  for (const scenario of report.results) {
    expect(scenario.ambiguousExitBars).toBe(1)
    const trade = scenario.sessionDetails[0]?.trades.find((entry) => entry.symbol === 'AAPL')
    expect(trade?.exitReason).toBe('STOP')
    expect(trade?.netPnlUsd ?? 0).toBeLessThan(0)
  }
})

test('a gap beyond the stop limit remains open until a modeled executable exit rather than filling at the stop', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, (symbol, minute) =>
    symbol === 'AAPL' && minute >= 125 ? 90 : middayPrice(symbol, minute),
  )
  const report = withRows(lines, (path) => runIntradayAlphaReplayVerification([path], calendar([date])))
  for (const scenario of report.results) {
    expect(scenario.stopLimitGapBars).toBeGreaterThan(0)
    const trade = scenario.sessionDetails[0]?.trades.find((entry) => entry.symbol === 'AAPL')
    expect(trade?.exitReason).toBe('EOD')
    expect(trade?.exitAt).toBe('2026-11-27T17:56:00.000Z')
    expect(trade?.exitPrice ?? 100).toBeLessThan(90)
    expect(trade?.netPnlUsd ?? 0).toBeLessThan(-1_500)
  }
})

test('morning holding duration starts at the modeled first fill and observes the native 60-minute cap', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, (symbol, minute) => {
    if (symbol === 'SPY') return 100 + minute * 0.001
    if (symbol === 'AAPL' && minute >= 30) return 101
    return 100 + Math.min(minute, 29) * 0.001
  })
  const report = withRows(lines, (path) => runIntradayAlphaReplayVerification([path], calendar([date])))
  for (const scenario of report.results) {
    const trade = scenario.sessionDetails[0]?.trades.find((entry) => entry.phase === IntradayAlphaPhase.MorningOrb)
    expect(trade?.entryAt).toBe('2026-11-27T15:02:00.000Z')
    expect(trade?.exitAt).toBe('2026-11-27T16:03:00.000Z')
    expect(trade?.exitReason).toBe('MAX_HOLD')
  }
})

test('rejects conflicting bar revisions and dates outside the supplied calendar', () => {
  const date = '2026-11-27'
  const original = rows(date, 1, () => 100)
  const changed = rows(date, 1, () => 101)
  withRows([...original, ...changed], (path) => {
    expect(() => runIntradayAlphaReplayVerification([path], calendar([date]))).toThrow('Conflicting revisions')
  })
  withRows(original, (path) => {
    expect(() => runIntradayAlphaReplayVerification([path], calendar(['2026-11-25']))).toThrow(
      'absent from the supplied provider calendar',
    )
  })
})

test('retains source hashes and counts harmless identical duplicates', () => {
  const date = '2026-11-27'
  const original = rows(date, 1, () => 100)
  const report = withRows([...original, ...original], (path) =>
    runIntradayAlphaReplayVerification([path], calendar([date])),
  )
  expect(report.inputRows.identicalDuplicates).toBe(5)
  expect(report.inputRows.uniqueBars).toBe(5)
  expect(report.sources[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(report.evidenceClass).toBe('RETROSPECTIVE_EVENT_TIME_BAR_SCENARIO')
})
