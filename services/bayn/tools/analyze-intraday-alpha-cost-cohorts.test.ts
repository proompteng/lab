import { expect, test } from 'bun:test'

import type { IsoDate } from '../src/schemas'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { analyzeIntradayAlphaCostCohorts as analyze } from './analyze-intraday-alpha-cost-cohorts'

const dates: IsoDate[] = ['2026-11-25', '2026-11-27']
const phase = IntradayAlphaPhase.MiddayReversion
const trade = (
  symbol: string,
  entryPrice = 100,
  exitPrice = 101,
  shares = 10,
  direction: 'LONG' | 'SHORT' = 'LONG',
) => {
  const gross = shares * (exitPrice - entryPrice) * (direction === 'LONG' ? 1 : -1)
  return {
    sessionDate: dates[0],
    phase,
    symbol,
    direction,
    shares,
    entryPrice,
    exitPrice,
    entryAt: dates[0] + 'T16:32:00.000Z',
    exitAt: dates[0] + 'T17:56:00.000Z',
    exitReason: 'EOD',
    grossPnlUsd: gross,
    netPnlUsd: gross,
  }
}

const day = (date: string, trades: ReturnType<typeof trade>[]) => ({
  date,
  baselineAvailable: true,
  benchmarkAvailable: true,
  expectedRegularMinutes: 210,
  benchmarkMinutes: 210,
  requiredBenchmarkCheckpoints: 1,
  unavailableBenchmarkCheckpoints: [] as { phase: IntradayAlphaPhase; observedAt: string; expectedBarAt: string }[],
  missingConcurrentMarkWindows: 0,
  trades,
  unresolvedExits: [] as { symbol: string; entryAt: string; exitDueAt: string; reason: string }[],
  attempts:
    trades.length === 0
      ? []
      : [
          {
            phase,
            observedAt: date + 'T16:31:02.000Z',
            orderExpiresAt: date + 'T16:32:02.000Z',
            occupiedSymbols: [] as string[],
            selectedSymbols: trades.map((item) => item.symbol),
            filledSymbols: trades.map((item) => item.symbol),
          },
        ],
})
const scenario = (slippageBps: number, trades: ReturnType<typeof trade>[]) => {
  const closed = trades.reduce((sum, item) => sum + item.netPnlUsd, 0)
  return {
    slippageBps,
    totalSessions: dates.length,
    evaluatedSessions: dates.length,
    unavailableSessions: 0,
    completeOutcomes: true,
    totalTrades: trades.length,
    modeledFilledLegs: trades.length,
    modeledClosedNet: closed,
    totalNet: closed as number | null,
    sessionDetails: dates.map((date, index) => day(date, index === 0 ? trades : [])),
  }
}
const report = () => ({
  schemaVersion: 'bayn.intraday-alpha-bar-scenario.v2',
  qualification: 'UNQUALIFIED',
  evidenceClass: 'RETROSPECTIVE_EVENT_TIME_BAR_SCENARIO',
  policySchemaVersion: 'bayn.intraday-alpha-policy.v2',
  policyHash: 'a'.repeat(64),
  calendarHash: 'b'.repeat(64),
  sources: [{ path: '/private/input/bars.tsv', sha256: 'c'.repeat(64), bytes: 100 }],
  partialBaselineScenario: false,
  baselineCoverage: {
    classification: 'SUPPLIED_BAR_BASELINE_SCENARIO',
    evaluationSessionsWithoutBaseline: 0,
    evaluationSessionsWithPartialBaseline: 0,
    missingBaselineSessionsBySymbol: {},
    adjustedDailySupplementSupplied: false,
  },
  assumptions: { modeledSellFeeBps: 0 },
  sessions: dates,
  results: [scenario(2, [trade('AAPL'), trade('AMD', 100, 99, 2)]), scenario(10, [trade('AAPL', 100.2, 100.8, 9)])],
})
const diagnose = (input: ReturnType<typeof report>) => analyze(JSON.stringify(input))

test('matches entry identity despite cost-altered prices and quantities and reconciles membership effects', () => {
  const input = report()
  const result = diagnose(input)
  const midday = result.byPhase.find((row) => row.phase === phase)
  expect(result.commonEntryCount).toBe(1)
  expect(midday?.sameExitClockAndReasonCount).toBe(1)
  expect(midday?.sameQuantityAndExitCount).toBe(0)
  expect(midday?.scenarios[0]?.supportedClosed.modeledClosedNet).toBe(8)
  expect(midday?.scenarios[0]?.commonEntries.modeledClosedNet).toBe(10)
  expect(midday?.scenarios[0]?.scenarioSpecificEntries.modeledClosedNet).toBe(-2)
  expect(midday?.scenarios[1]?.commonEntries.modeledClosedNet).toBeCloseTo(5.4)
  expect(midday?.lowestToHighestCost.commonEntryNetChange).toBeCloseTo(-4.6)
  expect(midday?.lowestToHighestCost.membershipContributionChange).toBe(2)
  expect(midday?.lowestToHighestCost.supportedClosedNetChange).toBeCloseTo(-2.6)
  expect(result.calendarRows.map((row) => row.date)).toEqual([...dates])
  expect(result.calendarRows[1]?.scenarios[0]?.completeDayModeledNet).toBe(0)
  expect(result.inputReportSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.sources[0]?.path).toBe('bars.tsv')
})

test('direction and entry clock remain identity while changed exit paths stay explicit', () => {
  const input = report()
  const high = input.results[1]
  if (high === undefined) throw new Error('fixture')
  high.sessionDetails[0] = day(dates[0] ?? '', [trade('AAPL', 100, 101, 10, 'SHORT')])
  high.modeledClosedNet = -10
  high.totalNet = -10
  expect(diagnose(input).commonEntryCount).toBe(0)

  const changedExit = report()
  const leg = changedExit.results[1]?.sessionDetails[0]?.trades[0]
  if (leg === undefined) throw new Error('fixture')
  leg.exitAt = dates[0] + 'T17:55:00.000Z'
  const matched = diagnose(changedExit).byPhase.find((row) => row.phase === phase)
  expect(matched?.commonEntryCount).toBe(1)
  expect(matched?.sameExitClockAndReasonCount).toBe(0)

  const changedEntry = report()
  const later = changedEntry.results[1]?.sessionDetails[0]
  const laterTrade = later?.trades[0]
  const laterAttempt = later?.attempts[0]
  if (laterTrade === undefined || laterAttempt === undefined) throw new Error('fixture')
  laterTrade.entryAt = dates[0] + 'T16:33:00.000Z'
  laterAttempt.observedAt = dates[0] + 'T16:32:02.000Z'
  laterAttempt.orderExpiresAt = dates[0] + 'T16:33:02.000Z'
  expect(diagnose(changedEntry).commonEntryCount).toBe(0)
})

test('rejects duplicate trade identities instead of silently overwriting a join', () => {
  const input = report()
  input.results[0] = scenario(2, [trade('AAPL'), trade('AAPL', 100.2, 101, 9)])
  const first = input.results[0]?.sessionDetails[0]
  if (first === undefined) throw new Error('fixture')
  first.attempts = day(dates[0] ?? '', [trade('AAPL')]).attempts
  expect(() => diagnose(input)).toThrow('Duplicate trade identity')
})

test('rejects missing calendar rows, duplicate cost scenarios and inconsistent totals', () => {
  const missing = report()
  missing.results[0]?.sessionDetails.pop()
  expect(() => diagnose(missing)).toThrow('every calendar session')

  const duplicate = report()
  if (duplicate.results[1] !== undefined) duplicate.results[1].slippageBps = 2
  expect(() => diagnose(duplicate)).toThrow('Cost scenarios must be unique')

  const totals = report()
  if (totals.results[0] !== undefined) totals.results[0].totalTrades = 99
  expect(() => diagnose(totals)).toThrow('Scenario counts')
})

test('retains an unavailable day and supported closed trades without restoring full-window profit', () => {
  const input = report()
  for (const cost of input.results) {
    const first = cost.sessionDetails[0]
    if (first === undefined) throw new Error('fixture')
    first.missingConcurrentMarkWindows = 1
    cost.unavailableSessions = 1
    cost.evaluatedSessions = 1
    cost.completeOutcomes = false
    cost.totalNet = null
  }
  const result = diagnose(input)
  expect(result.calendarRows).toHaveLength(2)
  expect(result.commonEntryCount).toBe(1)
  expect(result.calendarRows[0]?.scenarios[0]?.modeledClosedNet).toBe(8)
  expect(result.calendarRows[0]?.scenarios[0]?.completeDayModeledNet).toBeNull()
  expect(result.calendarRows[0]?.scenarios[0]?.missingConcurrentMarkWindows).toBe(1)
  expect(result.scenarioCoverage.every((row) => row.completeWindowModeledNet === null)).toBe(true)
  expect(result.scenarioCoverage.every((row) => row.unavailableSessions === 1)).toBe(true)
})

test('keeps a filled leg with an unresolved exit outside the closed-trade intersection', () => {
  const input = report()
  input.results = [scenario(2, []), scenario(10, [])]
  for (const cost of input.results) {
    const first = cost.sessionDetails[0]
    if (first === undefined) throw new Error('fixture')
    first.attempts = day(dates[0] ?? '', [trade('AAPL')]).attempts
    first.unresolvedExits = [
      {
        symbol: 'AAPL',
        entryAt: dates[0] + 'T16:32:00.000Z',
        exitDueAt: dates[0] + 'T17:55:00.000Z',
        reason: 'POST_DEADLINE_PRICE_UNAVAILABLE',
      },
    ]
    cost.modeledFilledLegs = 1
    cost.completeOutcomes = false
    cost.totalNet = null
  }
  const result = diagnose(input)
  expect(result.commonEntryCount).toBe(0)
  expect(result.scenarioCoverage.every((row) => row.unresolvedExits === 1)).toBe(true)
  expect(result.scenarioCoverage.every((row) => row.completeWindowModeledNet === null)).toBe(true)
  expect(result.calendarRows[0]?.scenarios[0]?.completeDayModeledNet).toBeNull()
})

test('validates fill ownership and price-derived economics before comparison', () => {
  const economics = report()
  const leg = economics.results[0]?.sessionDetails[0]?.trades[0]
  if (leg === undefined) throw new Error('fixture')
  leg.netPnlUsd = 1_000
  expect(() => diagnose(economics)).toThrow('Trade economics')

  const orphan = report()
  const first = orphan.results[0]?.sessionDetails[0]
  if (first === undefined) throw new Error('fixture')
  first.attempts = []
  expect(() => diagnose(orphan)).toThrow('committed filled-leg source')
})

test('retains missing benchmark checkpoint provenance and never treats it as a known zero', () => {
  const input = report()
  input.results = [scenario(2, []), scenario(10, [])]
  for (const cost of input.results) {
    const first = cost.sessionDetails[0]
    if (first === undefined) throw new Error('fixture')
    first.benchmarkAvailable = false
    first.benchmarkMinutes = 1
    first.unavailableBenchmarkCheckpoints = [
      {
        phase,
        observedAt: dates[0] + 'T16:31:02.000Z',
        expectedBarAt: dates[0] + 'T16:30:00.000Z',
      },
    ]
    cost.unavailableSessions = 1
    cost.evaluatedSessions = 1
    cost.completeOutcomes = false
    cost.totalNet = null
  }
  const result = diagnose(input)
  expect(result.calendarRows[0]?.scenarios[0]?.benchmarkMinutes).toBe(1)
  expect(result.calendarRows[0]?.scenarios[0]?.unavailableBenchmarkCheckpoints).toHaveLength(1)
  expect(result.calendarRows[0]?.scenarios[0]?.completeDayModeledNet).toBeNull()
})
