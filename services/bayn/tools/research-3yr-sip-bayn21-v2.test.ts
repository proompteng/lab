import { expect, test } from 'bun:test'
import { argumentsFor } from './research-3yr-sip-bayn21-v2'
import { admitRow, makeSession, readBar, readRegularCalendar } from './sip-bayn21-data'
import {
  createReplay,
  followExit,
  liveArchitecture,
  liveIdentity,
  modeledEntryLimit,
  modeledStopLimit,
  phases,
  simulate,
} from './sip-bayn21-replay'
import { aggregateDay, bootstrapP, inPeriod, summarize } from './sip-bayn21-statistics'

test('recognizes the PAPER v2 protocol without a production edit and refuses score-time configuration flags', () => {
  expect(liveIdentity.protocolHash).toBe('5863a919110021b7bf7f27872aafe0bed44092cf832f8d0e3a6fdb66fb73ff2d')
  expect(argumentsFor(['--freeze', '--output', 'new.json']).output).toBe('new.json')
  expect(() => argumentsFor(['--score', '--collar', '35'])).toThrow('Usage:')
  expect(() => argumentsFor(['--freeze', '--score'])).toThrow('Usage:')
})

test('partitions adjacent stages while preserving six calendar half-year panels', () => {
  expect(inPeriod('2025-06-30', 'train')).toBeTrue()
  expect(inPeriod('2025-07-01', 'train')).toBeFalse()
  expect(inPeriod('2025-07-01', 'validation')).toBeTrue()
  expect(inPeriod('2026-03-31', 'validation')).toBeTrue()
  expect(inPeriod('2026-04-01', 'validation')).toBeFalse()
  expect(inPeriod('2026-04-01', 'holdout')).toBeTrue()
  expect(inPeriod('2026-03-31', '2026H1')).toBeTrue()
  expect(inPeriod('2026-04-01', '2026H1')).toBeTrue()
  expect(inPeriod('2026-07-01', '2026H2')).toBeTrue()
})

test('keeps sparse minute slots, excludes the half-day close, rejects duplicates and never decodes holdout prices during freeze', () => {
  const date = '2025-11-28'
  const session = makeSession(date, Date.parse(`${date}T14:30:00Z`), 210)
  const sessions = new Map([[date, session]])
  const line = (at: string) => `SPY\t${date}T${at}:00Z\t100\t101\t99\t100\t500\t100`
  expect(admitRow(line('14:29'), sessions, date)).toBe('outsideRegular')
  expect(admitRow(line('14:30'), sessions, date)).toBe('regular')
  expect(admitRow(line('17:59'), sessions, date)).toBe('regular')
  expect(admitRow(line('18:00'), sessions, date)).toBe('outsideRegular')
  expect(readBar(session, 'SPY', 1)).toBeUndefined()
  expect(readBar(session, 'SPY', 209)?.close).toBe(100)
  expect(() => admitRow(line('14:30'), sessions, date)).toThrow('Duplicate RTH bar')
  expect(() => admitRow(line('14:31').replace('\t101\t', '\t98\t'), sessions, date)).toThrow('Invalid OHLCVV')
  expect(admitRow('SPY\t2026-04-01T13:30:00Z\tnot-prices', sessions, '2026-03-31')).toBe('outsideStage')
})

test('rounds side-aware collars and stop-limit offsets to executable equity ticks', () => {
  expect(modeledEntryLimit('AAPL', 1, 100, 25)).toBe(100.25)
  expect(modeledEntryLimit('AAPL', -1, 100, 35)).toBe(99.65)
  expect(modeledStopLimit('AAPL', 1, 99, 50)).toBe(98.51)
  expect(modeledStopLimit('AAPL', -1, 101, 50)).toBe(101.5)
})

test('leaves a gapped stop working without filling the target, or fills at the open with the wider buffer', () => {
  const bars = [
    { open: 99.7, high: 99.8, low: 99.6, close: 99.7 },
    undefined,
    { open: 100, high: 105, low: 99, close: 104 },
  ]
  const input = {
    barAt: (minute: number) => bars[minute],
    direction: 1,
    start: 0,
    due: 2,
    end: 3,
    stop: 100,
    limit: 99.9,
    target: 103,
    cost: 0,
    eodOnly: false,
  }
  expect(followExit(input)).toEqual({
    minute: 2,
    price: 100,
    reason: 'stop',
    blockedMinutes: 1,
    missingMinutes: 1,
    ambiguousBars: 0,
  })
  expect(followExit({ ...input, limit: 99.5 })).toMatchObject({ minute: 0, price: 99.7, blockedMinutes: 0 })
  expect(followExit({ ...input, direction: -1, stop: 99.65, limit: 99.75, target: 99 })).toMatchObject({
    minute: 0,
    price: 99.7,
    reason: 'stop',
  })
  expect(followExit({ ...input, due: 0, eodOnly: true })).toMatchObject({
    minute: 2,
    price: 100,
    reason: 'timed',
    missingMinutes: 1,
  })
  expect(followExit({ ...input, end: 2, due: 0, eodOnly: true })).toMatchObject({ price: null, reason: 'unresolved' })
})

test('uses the same calendar, positions and funding for t+1 versus t+2; an exact missing open cannot fill', () => {
  const dates = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25'] as const
  const calendar = readRegularCalendar({
    response: dates.map((date) => ({ date, open: '09:30', close: '13:00' })),
    query: { start: dates[0], end: dates[5] },
  })
  const replay = createReplay(calendar)
  const sessions = new Map(dates.map((date) => [date, makeSession(date, Date.parse(`${date}T14:30:00Z`), 210)]))
  for (const [date, session] of sessions)
    for (const [symbol, slope] of [
      ['SPY', 0],
      ['AAPL', -0.02],
      ['AMD', 0.02],
      ['AMZN', -0.01],
      ['AVGO', 0.01],
      ['WDC', -0.008],
      ['COHR', -0.006],
      ['TSLA', 0.008],
      ['GOOGL', 0.006],
      ['SNDK', 0.4],
    ] as const) {
      for (let minute = 0; minute < session.minutes; minute++) {
        if (date === dates[5] && minute === 121 && symbol === 'AMZN') continue
        const price = date === dates[5] ? 100 + Math.max(0, Math.min(minute, 120) - 90) * slope : 100 + minute / 10_000
        const at = new Date(session.openMs + minute * 60_000).toISOString()
        admitRow(
          `${symbol}\t${at}\t${price}\t${price + 0.01}\t${price - 0.01}\t${price}\t1000\t${price}`,
          sessions,
          date,
        )
      }
    }
  const prepared = [...sessions.values()].map(replay).at(-1)
  if (prepared === undefined) throw new Error('Fixture has no session')
  expect(prepared.sndkReady).toBeFalse()
  const scenario = {
    architecture: { ...liveArchitecture, sleeves: [phases[1]] },
    cost: 5,
    collar: 10,
    stopBuffer: 10,
  } as const
  const optimistic = simulate(prepared, { ...scenario, lag: 1 })
  const causal = simulate(prepared, { ...scenario, lag: 2 })
  expect(optimistic).toMatchObject({ middaySelected: 4, middayFilled: 3, missingEntryPrices: 1 })
  expect(causal).toMatchObject({ middaySelected: 4, middayFilled: 4, missingEntryPrices: 0 })
  expect(
    causal.trades
      .toSorted((a, b) => a.symbol.localeCompare(b.symbol))
      .map(({ symbol, entryMinute, exit }) => [symbol, entryMinute, exit.minute]),
  ).toEqual([
    ['AAPL', 122, 206],
    ['AMD', 122, 206],
    ['AMZN', 122, 206],
    ['AVGO', 122, 206],
  ])
  expect(causal.maxGrossUsd).toBeLessThan(180_000)
  const threePairs = simulate(prepared, {
    ...scenario,
    architecture: { ...scenario.architecture, pairs: 3 },
    lag: 2,
  })
  expect(threePairs).toMatchObject({ middaySelected: 6, middayFilled: 6 })
  expect(threePairs.trades.map(({ symbol }) => symbol).sort()).toEqual(['AAPL', 'AMD', 'AMZN', 'AVGO', 'TSLA', 'WDC'])
})

test('computes reproducible circular block tails and counts basket fills against committed four-leg orders', () => {
  const day = aggregateDay('2026-01-02', {
    trades: [],
    middaySelected: 4,
    middayFilled: 3,
    missingEntryPrices: 0,
    benchmarkBlocks: 0,
    plannerBlocks: 0,
    capBlocks: 0,
    maxGrossUsd: 0,
  })
  const days = [10, 8, 7, 5, 4, -3, -4].map((net) => ({ ...day, net }))
  expect(summarize(days, 5)).toMatchObject({
    netUsd: 27,
    maxDrawdownUsd: 7,
    exTop5NetUsd: -7,
    middayFourLegOrders: 7,
    middayFourLegCompletenessPct: 0,
  })
  expect(bootstrapP(days.map(({ net }) => net))).toBe(bootstrapP(days.map(({ net }) => net)))
  expect(bootstrapP(Array<number>(14).fill(1))).toBe(1 / 10_001)
  expect(bootstrapP(Array<number>(14).fill(-1))).toBe(1)
  expect(bootstrapP([0, 0])).toBe(1)
})
