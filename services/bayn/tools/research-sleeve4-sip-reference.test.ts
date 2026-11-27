import { expect, test } from 'bun:test'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { dailyReference, makeWindows, partitionMonths } from './research-sleeve4-sip-reference'

test('partitions symbol-major tapes without dropping, duplicating or reordering rows within a month', () => {
  const janA = 'AAPL\t2024-01-02T14:30:00Z\t100\t101\t99\t100\t1\t100\n'
  const febA = janA.replace('01-02', '02-02')
  const janB = janA.replace('AAPL', 'QQQ')
  const febB = febA.replace('AAPL', 'QQQ').trimEnd()
  const input = Buffer.from(janA + febA + janB + febB)
  const result = partitionMonths(input, 4)
  expect(Buffer.concat(result.get('2024-01') ?? []).toString()).toBe(janA + janB)
  expect(Buffer.concat(result.get('2024-02') ?? []).toString()).toBe(febA + febB)
  expect(() => partitionMonths(input, 5)).toThrow('row count')
  expect(() => partitionMonths(Buffer.from('corrupt line\n' + janB), 2)).toThrow('row 1')
  expect(() => partitionMonths(Buffer.from(janA.replace('01-02', '13-02')), 1)).toThrow('Invalid month')
})

test('windows emit each quarter once and include the complete rolling warmup at fiscal and calendar boundaries', () => {
  expect(
    makeWindows(
      ['2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04'],
      '2026-04-16',
    ),
  ).toEqual([
    { start: '2025-08-01', end: '2025-10-31', months: ['2025-08', '2025-09', '2025-10'] },
    { start: '2025-11-01', end: '2026-01-31', months: ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01'] },
    { start: '2026-02-01', end: '2026-04-16', months: ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04'] },
  ])
})

test('zero engine outcomes survive only when the full joint replay is supported', () => {
  const day = {
    date: '2026-04-01',
    baselineAvailable: true,
    benchmarkAvailable: true,
    baselineMissingSymbols: [],
    missingConcurrentMarkWindows: 0,
    unresolvedExits: [],
    trades: [],
  }
  expect(dailyReference(day, 100_000)).toEqual({
    date: '2026-04-01',
    deficiencies: [],
    net: [0, 0, 0],
    traded: [false, false, false],
  })
  expect(
    dailyReference({ ...day, baselineMissingSymbols: ['SNDK'], missingConcurrentMarkWindows: 1 }, 100_000),
  ).toEqual({
    date: '2026-04-01',
    deficiencies: ['PARTIAL_BASELINE', 'COHELD_MARK_GAP'],
    net: null,
    traded: null,
  })
  expect(dailyReference({ ...day, benchmarkAvailable: false }, 100_000).net).toBeNull()
})

test('engine net is scaled from modeled net dollars without averaging or dropping losing legs', () => {
  const day = {
    date: '2026-04-01',
    baselineAvailable: true,
    benchmarkAvailable: true,
    baselineMissingSymbols: [],
    missingConcurrentMarkWindows: 0,
    unresolvedExits: [],
    trades: [4, -4, -20].map((netPnlUsd, i) => ({
      phase: i === 2 ? IntradayAlphaPhase.NoiseAreaTrend : IntradayAlphaPhase.MorningOrb,
      netPnlUsd,
    })),
  }
  expect(dailyReference(day, 100_000).net).toEqual([0, 0, -2])
  expect(dailyReference(day, 100_000).traded).toEqual([true, false, true])
})
