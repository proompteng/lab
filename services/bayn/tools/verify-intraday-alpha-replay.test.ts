import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/policy'
import { runIntradayAlphaReplayVerification as runReplay } from './verify-intraday-alpha-replay'

const historyDates = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24']

const calendar = (dates: readonly string[], close = '13:00') => ({
  query: { start: historyDates[0], end: dates.at(-1) },
  response: [...historyDates, ...dates].map((date) => ({
    date,
    open: '09:30',
    close: historyDates.includes(date) ? '16:00' : close,
    session_open: '0400',
    session_close: '2000',
  })),
})

const runIntradayAlphaReplayVerification = (paths: readonly string[], input: ReturnType<typeof calendar>) =>
  runReplay(paths, input, { evaluationStart: input.response[historyDates.length]?.date })

const rows = (
  date: string,
  minutes: number,
  price: (symbol: string, minute: number) => number | null,
  symbols: readonly string[] = ['SPY', 'AAPL', 'AMD', 'AMZN', 'AVGO'],
) => {
  const result: string[] = []
  const openMs = Date.parse(`${date}T14:30:00.000Z`)
  for (const symbol of symbols) {
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

const withRows = <A>(lines: readonly string[], run: (path: string) => A, includeHistory = true): A => {
  const directory = mkdtempSync(join(tmpdir(), 'bayn-alpha-replay-'))
  const path = join(directory, 'bars.tsv')
  try {
    const history = includeHistory
      ? historyDates.flatMap((date) =>
          rows(date, 390, (_symbol, minute) => 100 + minute * 0.0001, [
            'SPY',
            'AAPL',
            'AMD',
            'AMZN',
            'AVGO',
            'QQQ',
            'SMH',
          ]),
        )
      : []
    writeFileSync(path, `${[...history, ...lines].join('\n')}\n`)
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

test('an unfilled morning intent consumes the v2 single attempt from durable production history', () => {
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
    expect(morning?.map((attempt) => attempt.selectedSymbols)).toEqual([['AAPL']])
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

test('retains a session with no current benchmark as unavailable even when its prior baseline is valid', () => {
  const dates = ['2026-11-25', '2026-11-27']
  const report = withRows(rows(dates[0] ?? '', 210, middayPrice), (path) =>
    runIntradayAlphaReplayVerification([path], calendar(dates)),
  )
  expect(report.sessions).toEqual(dates)
  for (const scenario of report.results) {
    const missing = scenario.sessionDetails[1]
    expect(missing?.baselineAvailable).toBe(true)
    expect(missing?.benchmarkAvailable).toBe(false)
    expect(missing?.benchmarkMinutes).toBe(0)
    expect(missing?.attempts).toEqual([])
    expect(missing?.trades).toEqual([])
    expect(scenario.totalSessions).toBe(2)
    expect(scenario.evaluatedSessions).toBe(1)
    expect(scenario.unavailableSessions).toBe(1)
    expect(scenario.totalNet).toBeNull()
    expect(scenario.sharpe).toBeNull()
    expect(scenario.maxDd).toBeNull()
    expect(scenario.chronologicalSlices).toBeNull()
    expect(scenario.recentDays[1]?.modeledNet).toBeNull()
  }
})

test('an opening-only or stale benchmark cannot become an evaluated zero-profit day', () => {
  const date = '2026-11-27'
  for (const coverage of ['opening-only', 'missing-checkpoint'] as const) {
    const lines = rows(date, 210, (symbol, minute) => {
      if (symbol === 'SPY' && (coverage === 'opening-only' ? minute > 0 : minute === 30)) return null
      return middayPrice(symbol, minute)
    })
    const report = withRows(lines, (path) => runIntradayAlphaReplayVerification([path], calendar([date])))
    for (const scenario of report.results) {
      const day = scenario.sessionDetails[0]
      expect(day?.baselineAvailable).toBe(true)
      expect(day?.benchmarkMinutes).toBe(coverage === 'opening-only' ? 1 : 209)
      expect(day?.benchmarkAvailable).toBe(false)
      expect(day?.requiredBenchmarkCheckpoints).toBe(1)
      expect(day?.unavailableBenchmarkCheckpoints).toEqual([
        {
          phase: IntradayAlphaPhase.NoiseAreaTrend,
          observedAt: '2026-11-27T15:01:02.000Z',
          expectedBarAt: '2026-11-27T15:00:00.000Z',
        },
      ])
      expect(day?.attempts).toEqual([])
      expect(scenario.completeOutcomes).toBe(false)
      expect(scenario.evaluatedSessions).toBe(0)
      expect(scenario.unavailableSessions).toBe(1)
      expect(scenario.totalNet).toBeNull()
      expect(scenario.sharpe).toBeNull()
      expect(scenario.maxDd).toBeNull()
      expect(scenario.chronologicalSlices).toBeNull()
      expect(scenario.orbNet).toBeNull()
      expect(scenario.mrNet).toBeNull()
      expect(scenario.noiseNet).toBeNull()
      expect(scenario.recentDays[0]?.modeledNet).toBeNull()
    }
  }
})

test('a later unavailable benchmark halts new entries but preserves an existing trade and its later exit', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, (symbol, minute) => {
    if (symbol === 'SPY') return minute === 90 ? null : 100 + minute * 0.001
    if (symbol === 'AAPL' && minute >= 30) return 101
    return 100 + Math.min(minute, 29) * 0.001
  })
  const report = withRows(lines, (path) => runIntradayAlphaReplayVerification([path], calendar([date])))
  for (const scenario of report.results) {
    const day = scenario.sessionDetails[0]
    expect(day?.unavailableBenchmarkCheckpoints).toEqual([
      {
        phase: IntradayAlphaPhase.NoiseAreaTrend,
        observedAt: '2026-11-27T16:01:02.000Z',
        expectedBarAt: '2026-11-27T16:00:00.000Z',
      },
    ])
    expect(day?.attempts).toHaveLength(1)
    expect(day?.trades).toHaveLength(1)
    expect(day?.trades[0]?.phase).toBe(IntradayAlphaPhase.MorningOrb)
    expect(day?.trades[0]?.exitAt).toBe('2026-11-27T16:03:00.000Z')
    expect(scenario.modeledFilledLegs).toBe(1)
    expect(scenario.modeledClosedNet).toBe(day?.trades[0]?.netPnlUsd)
    expect(scenario.orbModeledClosedNet).toBe(scenario.modeledClosedNet)
    expect(scenario.orbNet).toBeNull()
    expect(scenario.totalNet).toBeNull()
    expect(scenario.recentDays[0]?.modeledNet).toBeNull()
  }
})

test('a current finite zero benchmark signal can support a known zero-trade result', () => {
  const date = '2026-11-27'
  const report = withRows(
    rows(date, 210, () => 100),
    (path) => runIntradayAlphaReplayVerification([path], calendar([date])),
  )
  for (const scenario of report.results) {
    const day = scenario.sessionDetails[0]
    expect(day?.benchmarkAvailable).toBe(true)
    expect(day?.requiredBenchmarkCheckpoints).toBeGreaterThan(0)
    expect(day?.unavailableBenchmarkCheckpoints).toEqual([])
    expect(day?.attempts).toEqual([])
    expect(scenario.completeOutcomes).toBe(true)
    expect(scenario.evaluatedSessions).toBe(1)
    expect(scenario.unavailableSessions).toBe(0)
    expect(scenario.totalNet).toBe(0)
    expect(scenario.recentDays[0]?.modeledNet).toBe(0)
  }
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

test('missing current bars cannot be replaced by earlier or future references for selected targets', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, (symbol, minute) => {
    if (symbol === 'SPY') return 100 + minute * 0.001
    if (symbol === 'AAPL') {
      if (minute === 30) return null
      if (minute > 30) return 101
    }
    if (symbol === 'AMZN' && minute < 40) return null
    return 100 + Math.min(minute, 29) * 0.001
  })
  const report = withRows(lines, (path) => runIntradayAlphaReplayVerification([path], calendar([date])))
  for (const scenario of report.results) {
    const morning = scenario.sessionDetails[0]?.attempts.filter(
      (attempt) => attempt.phase === IntradayAlphaPhase.MorningOrb,
    )
    expect(morning).toHaveLength(1)
    expect(morning?.[0]?.selectedSymbols).toEqual(['AAPL'])
    expect(morning?.[0]?.observedAt).toBe('2026-11-27T15:02:02.000Z')
    const trade = scenario.sessionDetails[0]?.trades.find((entry) => entry.phase === IntradayAlphaPhase.MorningOrb)
    expect(trade?.entryAt).toBe('2026-11-27T15:03:00.000Z')
    expect(scenario.totalPlannerBlocks).toBe(0)
  }
})

test('concurrent sleeves wait for entry resolution and retain only filled disjoint inventory', () => {
  const date = '2026-11-27'
  const equities = rows(date, 210, (symbol, minute) => {
    if (symbol === 'SPY') return 100 + minute * 0.001
    if (symbol === 'AAPL' && minute >= 30) return 101
    return 100 + Math.min(minute, 29) * 0.001
  })
  const etfs = rows(
    date,
    210,
    (symbol, minute) => {
      if (symbol === 'SMH' && minute === 32) return 103
      return 100 + Math.min(minute, 30) * 0.01
    },
    ['QQQ', 'SMH'],
  )
  const report = withRows([...equities, ...etfs], (path) =>
    runIntradayAlphaReplayVerification([path], calendar([date])),
  )
  for (const scenario of report.results) {
    const day = scenario.sessionDetails[0]
    const noise = day?.attempts.find((attempt) => attempt.phase === IntradayAlphaPhase.NoiseAreaTrend)
    const morning = day?.attempts.find((attempt) => attempt.phase === IntradayAlphaPhase.MorningOrb)
    expect(noise?.selectedSymbols).toEqual(['QQQ', 'SMH'])
    expect(noise?.filledSymbols).toEqual(['QQQ'])
    expect(morning?.occupiedSymbols).toEqual(['QQQ'])
    expect((morning?.observedAt ?? '') >= (noise?.orderExpiresAt ?? 'z')).toBe(true)
    expect(scenario.concurrentOverlaps).toBeGreaterThan(0)
    expect(scenario.maximumConcurrentLegs).toBeGreaterThanOrEqual(2)
    expect(scenario.totalPlannerBlocks).toBe(0)
    const qqq = day?.trades.find((trade) => trade.symbol === 'QQQ')
    expect(qqq?.entryAt).toBe('2026-11-27T15:02:00.000Z')
    expect(qqq?.exitAt).toBe('2026-11-27T17:59:00.000Z')
    expect(day?.trades.some((trade) => trade.symbol === 'SMH')).toBe(false)
  }
})

test('a missing required co-held mark halts planning and retains already supported noise exits', () => {
  const date = '2026-11-27'
  const equities = rows(date, 210, (symbol, minute) => {
    if (symbol === 'SPY') return 100 + minute * 0.001
    if (symbol === 'AAPL' && minute >= 30) return 101
    return 100 + Math.min(minute, 29) * 0.001
  })
  const etfs = rows(
    date,
    210,
    (symbol, minute) => (symbol === 'QQQ' && minute === 31 ? null : 100 + Math.min(minute, 30) * 0.01),
    ['QQQ', 'SMH'],
  )
  const report = withRows([...equities, ...etfs], (path) =>
    runIntradayAlphaReplayVerification([path], calendar([date])),
  )
  for (const scenario of report.results) {
    const day = scenario.sessionDetails[0]
    expect(day?.benchmarkAvailable).toBe(true)
    expect(day?.missingConcurrentMarkWindows).toBe(1)
    expect(day?.attempts).toHaveLength(1)
    expect(day?.trades).toHaveLength(2)
    expect(day?.trades.every((trade) => trade.phase === IntradayAlphaPhase.NoiseAreaTrend)).toBe(true)
    expect(day?.trades.every((trade) => trade.exitAt === '2026-11-27T17:59:00.000Z')).toBe(true)
    expect(scenario.modeledFilledLegs).toBe(2)
    expect(scenario.modeledClosedNet).toBe(day?.trades.reduce((sum, trade) => sum + trade.netPnlUsd, 0))
    expect(scenario.completeOutcomes).toBe(false)
    expect(scenario.unavailableSessions).toBe(1)
    expect(scenario.totalNet).toBeNull()
    expect(scenario.sharpe).toBeNull()
    expect(scenario.maxDd).toBeNull()
    expect(scenario.chronologicalSlices).toBeNull()
    expect(scenario.recentDays[0]?.modeledNet).toBeNull()
    expect(scenario.diagnostics.coHeldMarkGaps).toEqual([
      {
        date,
        phase: IntradayAlphaPhase.MorningOrb,
        symbol: 'QQQ',
        observedAt: '2026-11-27T15:02:02.000Z',
        expectedBarAt: '2026-11-27T15:01:00.000Z',
        lastPriorBarAt: '2026-11-27T15:00:00.000Z',
        ageMinutes: 1,
        carried: false,
      },
    ])
    expect(scenario.diagnostics.carryForwardSensitivity).toMatchObject({
      evidenceClass: 'DIAGNOSTIC_ONLY_NON_QUALIFYING',
      maximumAgeMinutes: 2,
      sessions: [
        {
          date,
          completeWithCarry: true,
          gaps: [{ symbol: 'QQQ', carried: true }],
          strictEntryAttempts: 1,
          carriedEntryAttempts: 3,
        },
      ],
    })
  }
})

test('missing benchmark bars outside an available decision window do not fabricate missing observations', () => {
  const date = '2026-11-27'
  const equities = rows(date, 210, (symbol, minute) => {
    if (symbol === 'SPY') return minute === 90 ? null : 100 + minute * 0.001
    if (symbol === 'AAPL' && minute >= 30) return 101
    return 100 + Math.min(minute, 29) * 0.001
  })
  const etfs = rows(date, 210, (_symbol, minute) => 100 + Math.min(minute, 30) * 0.01, ['QQQ', 'SMH'])
  const report = withRows([...equities, ...etfs], (path) =>
    runIntradayAlphaReplayVerification([path], calendar([date])),
  )
  for (const scenario of report.results) {
    const day = scenario.sessionDetails[0]
    expect(day?.attempts.some((attempt) => attempt.phase === IntradayAlphaPhase.MorningOrb)).toBe(true)
    expect(
      day?.attempts.find((attempt) => attempt.phase === IntradayAlphaPhase.NoiseAreaTrend)?.selectedSymbols,
    ).toEqual(['QQQ', 'SMH'])
    expect(day?.benchmarkMinutes).toBe(209)
    expect(day?.benchmarkAvailable).toBe(true)
    expect(day?.unavailableBenchmarkCheckpoints).toEqual([])
    expect(scenario.unavailableSessions).toBe(0)
    expect(scenario.completeOutcomes).toBe(true)
  }
})

test('v2 morning flatten caps a late fill at the absolute 11:28 ET deadline', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, (symbol, minute) => {
    if (symbol === 'SPY') return 100 + minute * 0.001
    if (symbol === 'AAPL' && minute >= 80) return 101
    return 100 + Math.min(minute, 29) * 0.001
  })
  const report = withRows(lines, (path) => runIntradayAlphaReplayVerification([path], calendar([date])))
  for (const scenario of report.results) {
    const trade = scenario.sessionDetails[0]?.trades.find((entry) => entry.phase === IntradayAlphaPhase.MorningOrb)
    expect(trade?.entryAt).toBe('2026-11-27T15:52:00.000Z')
    expect(trade?.exitAt).toBe('2026-11-27T16:29:00.000Z')
  }
})

test('missing supplied trailing history remains unavailable and cannot become a zero-profit evaluation', () => {
  const date = '2026-11-27'
  const report = withRows(
    rows(date, 210, middayPrice),
    (path) => runIntradayAlphaReplayVerification([path], calendar([date])),
    false,
  )
  expect(report.policySchemaVersion).toBe('bayn.intraday-alpha-policy.v2')
  expect(report.sessions).toEqual([date])
  for (const scenario of report.results) {
    expect(scenario.unavailableSessions).toBe(1)
    expect(scenario.evaluatedSessions).toBe(0)
    expect(scenario.totalNet).toBeNull()
    expect(scenario.sharpe).toBeNull()
    expect(scenario.recentDays[0]?.modeledNet).toBeNull()
    expect(scenario.sessionDetails[0]?.baselineAvailable).toBe(false)
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
  const report = withRows(
    [...original, ...original],
    (path) => runIntradayAlphaReplayVerification([path], calendar([date])),
    false,
  )
  expect(report.inputRows.identicalDuplicates).toBe(5)
  expect(report.inputRows.uniqueBars).toBe(5)
  expect(report.sources[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(report.evidenceClass).toBe('RETROSPECTIVE_EVENT_TIME_BAR_SCENARIO')
})

const quoteHeader =
  'symbol\tminute_utc\tquote_count\tfirst_bid\tfirst_ask\tlast_bid\tlast_ask\tmedian_spread_bps\tp75_spread_bps'
const quoteRows = (lines: readonly string[], skip: (symbol: string, at: string) => boolean = () => false) =>
  lines.flatMap((line) => {
    const [symbol = '', at = '', , , , close = ''] = line.split('\t')
    if (symbol === 'SPY' || skip(symbol, at)) return []
    const px = Number(close)
    return [[symbol, at, 20, px - 0.01, px + 0.01, px - 0.02, px + 0.02, 2, 4].join('\t')]
  })

test('L1 is additive, uses adverse first BBO on fills and reruns basket selection for LOSO', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, middayPrice)
  withRows(lines, (path) => {
    const quotes = join(dirname(path), 'quotes.tsv')
    writeFileSync(quotes, [quoteHeader, ...quoteRows(lines)].join('\n'))
    const report = runReplay([path], calendar([date]), { evaluationStart: date, quotes })
    expect(report.results).toEqual(runReplay([path], calendar([date]), { evaluationStart: date }).results)
    expect(report.l1?.model).toBe('IEX_L1_MINUTE_BBO')
    expect(report.l1?.slippageBps).toBeNull()
    expect(report.l1?.inputQuoteMinutes).toBe(840)
    const l1 = report.l1
    const day = l1?.sessionDetails[0]
    expect(l1?.totalTrades).toBe(4)
    expect(l1?.completeOutcomes).toBe(true)
    expect(l1?.diagnostics.middayFillCompleteness).toMatchObject({
      intendedFourLegBaskets: 1,
      completeFourLegBaskets: 1,
      completeFourLegRate: 1,
    })
    for (const trade of day?.trades ?? []) {
      const entryMinute = (Date.parse(trade.entryAt) - Date.parse(`${date}T14:30:00Z`)) / 60_000
      expect(trade.entryPrice).toBeCloseTo(
        middayPrice(trade.symbol, entryMinute) + (trade.direction === 'LONG' ? 0.01 : -0.01),
        8,
      )
      expect(trade.exitPrice).toBeCloseTo(
        middayPrice(trade.symbol, 206) + (trade.direction === 'LONG' ? -0.01 : 0.01),
        8,
      )
    }
    // Removing a long from the 2x2 set makes selection choose a balanced pair, not three existing legs.
    expect(l1?.diagnostics.leaveOneSymbolOut.find(({ omittedSymbol }) => omittedSymbol === 'AAPL')).toMatchObject({
      rerunSessions: 1,
      trades: 2,
      completeOutcomes: true,
    })
  })
})

test('L1 exit gaps do not fall back to a synthetic spread or a later price', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, middayPrice)
  withRows(lines, (path) => {
    const quotes = join(dirname(path), 'quotes.tsv')
    const minuteAt = `${date}T17:56:00.000Z`
    writeFileSync(
      quotes,
      [quoteHeader, ...quoteRows(lines, (symbol, at) => symbol === 'AAPL' && at === minuteAt)].join('\n'),
    )
    const report = runReplay([path], calendar([date]), { evaluationStart: date, quotes })
    expect(report.l1?.totalNet).toBeNull()
    expect(report.l1?.diagnostics.l1ExecutionGaps).toEqual([{ symbol: 'AAPL', minuteAt, stage: 'EXIT' }])
    expect(report.l1?.sessionDetails[0]?.unresolvedExits).toMatchObject([
      { symbol: 'AAPL', reason: 'L1_EXIT_MINUTE_UNAVAILABLE' },
    ])
    expect(report.l1?.sessionDetails[0]?.trades).toHaveLength(3)
  })
})

test('rejects crossed and duplicate L1 rows', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, middayPrice)
  withRows(lines, (path) => {
    const quotes = join(dirname(path), 'quotes.tsv')
    const good = `AAPL\t${date}T14:30:00Z\t1\t100\t101\t100\t101\t5\t10`
    const bad = good.replace('100\t101', '101\t100')
    writeFileSync(quotes, [quoteHeader, bad].join('\n'))
    expect(() => runReplay([path], calendar([date]), { evaluationStart: date, quotes })).toThrow('Invalid L1 minute')
    writeFileSync(quotes, [quoteHeader, good, good].join('\n'))
    expect(() => runReplay([path], calendar([date]), { evaluationStart: date, quotes })).toThrow('Duplicate L1 minute')
  })
})

test('a future bucket does not fill the decision quote and wide entry BBO cannot cross the limit', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, middayPrice)
  withRows(lines, (path) => {
    const quotes = join(dirname(path), 'quotes.tsv')
    const adjusted = quoteRows(lines, (symbol, at) => symbol === 'AAPL' && at < `${date}T16:32:00.000Z`).map((line) => {
      if (!line.startsWith('AMZN\t')) return line
      const cols = line.split('\t')
      cols[3] = '90'
      cols[4] = '110'
      return cols.join('\t')
    })
    writeFileSync(quotes, [quoteHeader, ...adjusted].join('\n'))
    const report = runReplay([path], calendar([date]), { evaluationStart: date, quotes })
    const first = report.l1?.sessionDetails[0]?.attempts[0]
    expect(first?.selectedSymbols).toEqual(['AMD', 'AMZN'])
    expect(first?.filledSymbols).toEqual(['AMD'])
  })
})

test('multi-year regular-only calendar and splits adjust only priors crossing the effective date', () => {
  const before = '2026-11-25'
  const effectiveDate = '2026-11-27'
  const extraOldDate = '2024-01-02'
  const input = {
    query: { start: extraOldDate, end: '2026-12-31' },
    response: [
      { date: extraOldDate, open: '09:30', close: '16:00' },
      ...calendar([before, effectiveDate], '16:00').response.map(({ date, open, close }) => ({
        date,
        open,
        close: date === effectiveDate ? '13:00' : close,
      })),
      { date: '2026-11-30', open: '09:30', close: '16:00' },
    ],
  }
  const bars = [
    ...rows(before, 390, (symbol, minute) => (symbol === 'QQQ' ? 100 + minute * 0.0001 : 100), ['SPY', 'QQQ']),
    ...rows(effectiveDate, 210, (symbol, minute) => (symbol === 'QQQ' ? 50 + Math.min(30, minute) * 0.01 : 100), [
      'SPY',
      'QQQ',
    ]),
  ]
  withRows(bars, (path) => {
    const splits = join(dirname(path), 'splits.json')
    const options = { evaluationStart: before, evaluationEnd: effectiveDate }
    writeFileSync(splits, JSON.stringify([{ symbol: 'QQQ', effectiveDate, newShares: 2, oldShares: 1 }]))
    const unadjusted = runReplay([path], input, options)
    const adjusted = runReplay([path], input, { ...options, splits })
    expect(adjusted.historySessions).toContain(extraOldDate)
    expect(adjusted.sessions).toEqual([before, effectiveDate])
    expect(adjusted.splitAdjustments?.splits).toHaveLength(1)
    for (const [index, scenario] of adjusted.results.entries()) {
      const original = unadjusted.results[index]
      expect(scenario.sessionDetails[0]).toEqual(original?.sessionDetails[0])
      expect(scenario.sessionDetails[1]?.baselineHash).not.toEqual(original?.sessionDetails[1]?.baselineHash)
      expect(scenario.sessionDetails[1]?.attempts[0]?.selectedSymbols).toEqual(['QQQ'])
      expect(original?.sessionDetails[1]?.attempts).toEqual([])
    }
  })
})

test('carry-forward sensitivity still blocks when the last co-held mark is more than two minutes old', () => {
  const date = '2026-11-27'
  const lines = [
    ...rows(date, 210, middayPrice),
    ...rows(
      date,
      210,
      (_symbol, minute) => (minute >= 118 && minute <= 120 ? null : 100 + Math.min(minute, 30) * 0.01),
      ['QQQ'],
    ),
  ]
  const report = withRows(lines, (path) => runReplay([path], calendar([date]), { evaluationStart: date }))
  for (const scenario of report.results) {
    expect(scenario.totalNet).toBeNull()
    expect(scenario.diagnostics.carryForwardSensitivity.sessions).toMatchObject([
      {
        date,
        completeWithCarry: false,
        deltaModeledClosedNetUsd: 0,
        gaps: [{ symbol: 'QQQ', expectedBarAt: `${date}T16:30:00.000Z`, ageMinutes: 3, carried: false }],
      },
    ])
  }
})

test('unmatched L1 input cannot manufacture a complete zero-profit day', () => {
  const date = '2026-11-27'
  withRows(rows(date, 210, middayPrice), (path) => {
    const quotes = join(dirname(path), 'quotes.tsv')
    writeFileSync(quotes, [quoteHeader, ...quoteRows(rows('2026-11-25', 210, middayPrice))].join('\n'))
    const report = runReplay([path], calendar([date]), { evaluationStart: date, quotes })
    expect(report.l1?.diagnostics.sessionsWithoutDecisionL1Quotes).toEqual([date])
    expect(report.l1?.totalNet).toBeNull()
    expect(report.l1?.unavailableSessions).toBe(1)
  })
})

test('CLI opt-in preserves default v2 and feeds v2.1 collars and residual reductions into replay', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, (symbol, minute) => {
    if (minute === 122 && symbol === 'AAPL') return 99.6
    if (minute === 122 && symbol === 'AVGO') return 99
    return middayPrice(symbol, minute)
  })
  withRows(lines, (path) => {
    const calendarPath = join(dirname(path), 'calendar.json')
    writeFileSync(calendarPath, JSON.stringify(calendar([date])))
    const args = [
      process.execPath,
      join(import.meta.dir, 'verify-intraday-alpha-replay.ts'),
      '--calendar',
      calendarPath,
      '--evaluation-start',
      date,
      path,
    ]
    const execute = (...policyArgs: string[]) => Bun.spawnSync([...args, ...policyArgs])
    const defaultRun = execute()
    const explicitV2 = execute('--policy', 'v2')
    expect(defaultRun.exitCode).toBe(0)
    expect(explicitV2.exitCode).toBe(0)
    expect(defaultRun.stdout.toString()).toBe(explicitV2.stdout.toString())
    const candidateRun = execute('--policy', 'v2_1')
    expect(candidateRun.stderr.toString()).toBe('')
    expect(candidateRun.exitCode).toBe(0)
    expect(execute('--policy', 'v3').exitCode).not.toBe(0)

    const v2 = runReplay([path], calendar([date]), { evaluationStart: date })
    const v21 = runReplay([path], calendar([date]), { evaluationStart: date, policy: 'v2_1' })
    expect(JSON.parse(candidateRun.stdout.toString())).toEqual(v21)
    expect(v2.policyHash).toBe('f632170473534577a59a98c800bca69917b710c3857a68d0c52ec776ebcdd509')
    expect(v21.policyHash).toBe('5b3c0205f2ff3ba18bc70197fbc4b715fd8d1f721ea59114232bde95fde527bd')
    expect(v21.qualification).toBe('UNQUALIFIED')
    const v2Day = v2.results[0]?.sessionDetails[0]
    const v21Day = v21.results[0]?.sessionDetails[0]
    expect(v2Day?.attempts[0]?.filledSymbols).toEqual(['AMD', 'AMZN'])
    const attempt = v21Day?.attempts[0]
    expect(attempt?.filledSymbols.toSorted()).toEqual(['AAPL', 'AMD', 'AMZN'])
    expect(attempt?.residualProtection).toMatchObject({ status: 'MODELED', observedAt: '2026-11-27T16:33:00.000Z' })
    const protection = attempt?.residualProtection
    if (protection?.status !== 'MODELED') throw new Error('Expected modeled residual protection')
    const exposure = BigInt(protection.modeledSignedNotionalAfterTrimMicros)
    expect(exposure).toBeGreaterThanOrEqual(0n)
    expect(exposure).toBeLessThan(100_000_000n)
    const trims = v21Day?.trades.filter((trade) => trade.exitReason === 'MIDDAY_RESIDUAL_TRIM') ?? []
    expect(trims.map(({ symbol, shares }) => ({ symbol, shares }))).toEqual([...protection.trims])
    expect(trims.every((trade) => trade.exitAt === '2026-11-27T16:33:00.000Z')).toBe(true)
  })
})

test('v2.1 does not invent a trim or completed outcome without a residual checkpoint mark', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, (symbol, minute) => {
    if (symbol === 'AVGO' && minute === 122) return 99
    if (symbol === 'AAPL' && minute === 123) return null
    return middayPrice(symbol, minute)
  })
  withRows(lines, (path) => {
    const report = runReplay([path], calendar([date]), { evaluationStart: date, policy: 'v2_1' })
    const scenario = report.results[0]
    expect(scenario?.middayBaskets[0]?.residualProtection).toEqual({
      status: 'EVIDENCE_UNAVAILABLE',
      observedAt: '2026-11-27T16:33:00.000Z',
    })
    expect(scenario?.totalNet).toBeNull()
    expect(scenario?.sessionDetails[0]?.trades).toEqual([])
    expect(scenario?.sessionDetails[0]?.unresolvedExits.map((exit) => exit.reason)).toEqual(
      Array(3).fill('MIDDAY_RESIDUAL_EVIDENCE_UNAVAILABLE'),
    )
  })
})

test('v2.1 short stop fills at a modeled gap price that blocks v2', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, (symbol, minute) =>
    symbol === 'AMD' && minute === 123 ? 105.78 : middayPrice(symbol, minute),
  )
  withRows(lines, (path) => {
    const v2 = runReplay([path], calendar([date]), { evaluationStart: date })
    const candidate = runReplay([path], calendar([date]), { evaluationStart: date, policy: 'v2_1' })
    expect(v2.results[0]?.stopLimitGapBars).toBe(1)
    expect(candidate.results[0]?.stopLimitGapBars).toBe(0)
    expect(candidate.results[0]?.middayBaskets[0]).toMatchObject({ complete: true, filledLegs: 4 })
    expect(candidate.results[0]?.sessionDetails[0]?.trades.find((trade) => trade.symbol === 'AMD')).toMatchObject({
      direction: 'SHORT',
      exitReason: 'STOP',
      exitAt: '2026-11-27T16:33:00.000Z',
    })
  })
})

test('v2.1 protects the post-expiry open inventory without trimming legs that already exited', () => {
  const date = '2026-11-27'
  const lines = rows(date, 210, (symbol, minute) => {
    if (symbol === 'AVGO' && minute === 122) return 99
    return middayPrice(symbol, minute)
  }).map((line) => {
    const fields = line.split('\t')
    if (fields[0] === 'AMZN' && fields[1] === '2026-11-27T16:32:00.000Z') fields[3] = '110'
    return fields.join('\t')
  })
  withRows(lines, (path) => {
    const report = runReplay([path], calendar([date]), { evaluationStart: date, policy: 'v2_1' })
    const day = report.results[0]?.sessionDetails[0]
    const protection = day?.attempts[0]?.residualProtection
    expect(protection).toMatchObject({ status: 'MODELED', observedAt: '2026-11-27T16:33:00.000Z' })
    if (protection?.status !== 'MODELED') throw new Error('Expected modeled residual protection')
    expect(protection.trims.some((trim) => trim.symbol === 'AMZN')).toBe(false)
    expect(day?.trades.filter((trade) => trade.symbol === 'AMZN')).toMatchObject([
      { exitReason: 'TARGET', exitAt: '2026-11-27T16:32:00.000Z' },
    ])
  })
})
