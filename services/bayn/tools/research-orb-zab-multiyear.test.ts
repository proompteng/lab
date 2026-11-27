import { expect, test } from 'bun:test'
import { Effect, FileSystem } from 'effect'
import {
  adjustSplit,
  normalizeResearchCalendar,
  readResearchData,
  sessionFeatures,
  withPriorSessions,
  type Bar,
  type ResearchDay,
} from './research-orb-zab-data'
import { v2Noise, v2Orb } from './research-orb-zab-protocol'
import { planEntry, replay, simulateExit } from './research-orb-zab-simulation'
import { blockBootstrapP, deflatedSharpe, deflationBenchmark } from './research-orb-zab-statistics'

const bar = (open: number, overrides: Partial<Bar> = {}): Bar => ({
  open,
  close: open,
  high: open,
  low: open,
  volume: 100,
  vwap: open,
  ...overrides,
})
const features = (bars: readonly (Bar | undefined)[]) => withPriorSessions(sessionFeatures(bars), [])

test('regular calendar changes UTC open across DST and preserves half-days', () => {
  expect(
    normalizeResearchCalendar({
      query: { start: '2024-01-01', end: '2024-12-31' },
      response: [
        { date: '2024-01-02', open: '09:30', close: '16:00' },
        { date: '2024-07-03', open: '09:30', close: '13:00' },
      ],
    }),
  ).toEqual([
    { date: '2024-01-02', openMs: Date.parse('2024-01-02T14:30:00Z'), minutes: 390 },
    { date: '2024-07-03', openMs: Date.parse('2024-07-03T13:30:00Z'), minutes: 210 },
  ])
})

test('the NVDA split back-adjusts all price fields and inversely adjusts volume', () => {
  expect(adjustSplit('NVDA', '2024-06-07', bar(1000, { high: 1010, low: 990, close: 1005, vwap: 1002 }))).toEqual(
    bar(100, { high: 101, low: 99, close: 100.5, vwap: 100.2, volume: 1000 }),
  )
  expect(adjustSplit('NVDA', '2024-06-10', bar(100))).toEqual(bar(100))
  expect(adjustSplit('AMZN', '2024-06-07', bar(1000))).toEqual(bar(1000))
})

test('RVOL and completed-decision VWAP do not use later bars, and missing prior ranges are not zero volume', () => {
  const priors = Array.from({ length: 14 }, () => sessionFeatures(Array.from({ length: 30 }, () => bar(100))))
  const today = Array.from({ length: 6 }, () => bar(100, { volume: 200 }))
  const changed = today.with(5, bar(10_000, { volume: 1_000_000 }))
  expect(withPriorSessions(sessionFeatures(today), priors).relativeVolumes.get(5)).toBe(2)
  expect(withPriorSessions(sessionFeatures(changed), priors).relativeVolumes.get(5)).toBe(2)
  expect(sessionFeatures(changed).vwap[4]).toBe(100)
  expect(withPriorSessions(sessionFeatures(today), [undefined, ...priors.slice(1)]).relativeVolumes.get(5)).toBeNull()
})

test('crossing the collar requires an adverse-side-adjusted executable price in the next minute only', () => {
  expect(planEntry(undefined, 1, 100, 10, 2)).toEqual({ kind: 'missing-entry-minute' })
  expect(planEntry(bar(100.04), 1, 100, 10, 10)).toMatchObject({ atOpen: true, kind: 'filled' })
  expect(planEntry(bar(100.06), 1, 100, 10, 10)).toEqual({ kind: 'collar-miss' })
  expect(planEntry(bar(99.75, { high: 99.96 }), -1, 100, 10, 10)).toMatchObject({
    atOpen: false,
    price: 99.9,
    kind: 'filled',
  })
})

test('a one-R ratchet cannot move the stop inside its trigger bar; ambiguous bracket is stop-first', () => {
  const signal = {
    symbol: 'AAPL',
    side: 1 as const,
    close: 100,
    weight: 0.35,
    stopBps: 100,
    targetBps: 200,
    series: features([bar(100, { low: 99.5, high: 101 }), bar(99.8)]),
  }
  const fill = { kind: 'filled' as const, atOpen: true, raw: 100, price: 100 }
  const ratchet = { ...v2Orb, exit: 'breakeven' as const }
  expect(simulateExit(signal, fill, 0, 10, 2, ratchet).trade).toMatchObject({
    gross: expect.closeTo(-70),
    reason: 'stop',
  })
  const bothTouch = { ...signal, series: features([bar(100, { low: 98, high: 103 })]) }
  expect(simulateExit(bothTouch, fill, 0, 10, 2, ratchet).trade).toMatchObject({ gross: -350, reason: 'stop' })
})

test('checkpoint exits price the next available open and refuse unresolved end-of-day trades', () => {
  const bars = Array.from({ length: 32 }, () => bar(100))
  bars[29] = bar(99)
  bars[30] = bar(98)
  const signal = {
    symbol: 'QQQ',
    side: 1 as const,
    close: 100,
    weight: 0.25,
    stopBps: 500,
    targetBps: 1500,
    series: { ...features(bars), previousClose: 100, averageSwing: new Float64Array(32).fill(0.005) },
  }
  const trail = { ...v2Noise, checkpoint: 30 as const, clock: 'paper' as const, exit: 'vwap-boundary' as const }
  const fill = { kind: 'filled' as const, atOpen: true, raw: 100, price: 100 }
  expect(simulateExit(signal, fill, 28, 31, 2, trail).trade).toMatchObject({ gross: -500, reason: 'vwap-boundary' })
  const absentTail = { ...signal, series: { ...signal.series, bars: bars.slice(0, 30) } }
  expect(simulateExit(absentTail, fill, 28, 31, 2, trail).trade).toBeNull()
})

test('LOSO runs selection again rather than subtracting the excluded winner', () => {
  const make = (firstClose: number) => {
    const bars = Array.from({ length: 140 }, () => bar(100))
    bars[29] = bar(100, { close: 101, high: 101 })
    bars[30] = bar(firstClose)
    bars[31] = bar(firstClose)
    return { ...features(bars), atrRatio: 0.05 }
  }
  const day: ResearchDay = {
    date: '2025-01-02',
    openMs: 0,
    minutes: 140,
    symbols: new Map([
      ['SPY', make(102)],
      ['AAPL', make(105)],
      ['NVDA', make(102)],
    ]),
  }
  const symbols = ['AAPL', 'NVDA']
  expect(replay([day], v2Orb, symbols, 2)[0].trades[0]?.symbol).toBe('AAPL')
  expect(replay([day], v2Orb, symbols, 2, 'AAPL')[0].trades[0]?.symbol).toBe('NVDA')
})

test('a resting fill can hit the adverse stop in its fill minute but cannot earn a pre-fill target', () => {
  const signal = {
    symbol: 'AAPL',
    side: 1 as const,
    close: 100,
    weight: 0.35,
    stopBps: 100,
    targetBps: 200,
    series: features([bar(101, { high: 105, low: 98 }), bar(100)]),
  }
  const entry = { kind: 'filled' as const, atOpen: false, raw: 100, price: 100 }
  expect(simulateExit(signal, entry, 0, 1, 2, null).trade).toMatchObject({ gross: -350, reason: 'stop' })
  const noStop = { ...signal, series: features([bar(101, { high: 105, low: 100 }), bar(100)]) }
  expect(simulateExit(noStop, entry, 0, 1, 2, null).trade).toMatchObject({ gross: 0, reason: 'time' })
})

test('block bootstrap preserves unknown days and uses a deterministic, one-sided null', () => {
  const increasing = Array.from({ length: 61 }, (_, i) => 20 + i / 10)
  expect(blockBootstrapP(increasing)).toBe(0.001)
  expect(blockBootstrapP(increasing.map((x) => -x))).toBe(1)
  expect(blockBootstrapP(increasing.map((x, i) => (i === 20 ? null : x)))).toBeNull()
})

test('deflating against more trials raises the benchmark and shrinks confidence', () => {
  const series = [1, -2, 3, -1, 4, -3, 6, 0, 1, 4]
  const trialSharpes = [0.02, 0.03, -0.08, 0.15, -0.12]
  const small = deflatedSharpe(series, deflationBenchmark(trialSharpes, 5))
  const large = deflatedSharpe(series, deflationBenchmark(trialSharpes, 100))
  expect(small).not.toBeNull()
  expect(large).toBeLessThan(small ?? 0)
  expect(deflatedSharpe([0, 0, 0], 0)).toBeNull()
})

test('VWAP-only checkpoint exits do not require a contemporaneous historical band', () => {
  const bars = Array.from({ length: 32 }, () => bar(100))
  bars[29] = bar(99)
  bars[30] = bar(98)
  const signal = {
    symbol: 'QQQ',
    side: 1 as const,
    close: 100,
    weight: 0.25,
    stopBps: 500,
    targetBps: 1500,
    series: features(bars),
  }
  const fill = { kind: 'filled' as const, atOpen: true, raw: 100, price: 100 }
  const trail = { ...v2Noise, checkpoint: 30 as const, clock: 'paper' as const, exit: 'vwap' as const }
  expect(simulateExit(signal, fill, 28, 31, 2, trail).trade).toMatchObject({ gross: -500, reason: 'vwap' })
})

test('local research validates the frozen manifest as a typed effect failure before any other read', () => {
  const read: string[] = []
  const fs = FileSystem.makeNoop({
    readFile: (path) =>
      Effect.sync(() => {
        read.push(path)
        return new TextEncoder().encode('{}')
      }),
  })
  const result = Effect.runSync(
    Effect.result(readResearchData('fixture', false).pipe(Effect.provideService(FileSystem.FileSystem, fs))),
  )
  expect(read).toEqual(['fixture/MANIFEST.json'])
  expect(result).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ResearchEvidenceError', message: 'Frozen manifest SHA-256 mismatch' },
  })
})
