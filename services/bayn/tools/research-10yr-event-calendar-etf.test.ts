import { expect, test } from 'bun:test'

import type { Bar, Day } from './noise-area-study-replay'
import { gates, performance, tradeStatistics } from './research-10yr-event-calendar-etf'
import { normalizeResearchCalendar } from './research-lib/calendar'
import { wealth } from './research-lib/statistics'
import { calendarEvents, expectedCalendar, scheduledStatements } from './research/event-calendar-etf-calendar'
import {
  breakevenBps,
  candidate,
  formWindows,
  regularSessionOverlap,
  replay,
  Rule,
  sellFeeBps,
  symbols,
  trials,
  type Window,
} from './research/event-calendar-etf-replay'
import type { DailyFrame } from './research/macro-etf-core-dual-horizon-data'

const fixture = (start: string, end: string, marks?: (date: string, i: number) => readonly [number, number]) => {
  const calendar = normalizeResearchCalendar({
    query: { start, end },
    response: expectedCalendar(start, end).map(({ date }) => ({
      date,
      open: '09:30',
      close: date === '2024-07-03' ? '13:00' : '16:00',
    })),
  })
  const daily: DailyFrame[] = calendar.map(({ date, openMs, minutes }, i) => {
    const [open, close] = marks?.(date, i) ?? [101, 100]
    return {
      date,
      openAt: openMs,
      closeAt: openMs + minutes * 60_000,
      bars: new Map(
        symbols.map((symbol) => [symbol, { open, close, high: Math.max(open, close), low: Math.min(open, close) }]),
      ),
    }
  })
  const minutes: Day[] = calendar.map(({ date, minutes }) => ({ date, slots: minutes / 5, bars: new Map() }))
  return { daily, minutes }
}
const spy = (rule: Exclude<Rule, Rule.Composite>) => ({ id: `${rule}/SPY`, rule, symbols: ['SPY' as const] })
const makeBar = (open: number, close = open): Bar => ({
  open,
  close,
  high: Math.max(open, close),
  low: Math.min(open, close),
  volume: 100,
  vwap: open,
})

test('pins the Fed schedule and distinguishes market holidays from ordinary weekends and ad hoc closures', () => {
  expect(expectedCalendar('2016-01-04', '2026-11-25')).toHaveLength(2741)
  expect(scheduledStatements).toHaveLength(88)
  expect(new Set(scheduledStatements)).toHaveProperty('size', 88)
  expect(scheduledStatements.filter((date) => calendarEvents(date).fomc)).toHaveLength(87)
  expect(calendarEvents('2020-03-18').fomc).toBe(false)
  expect(calendarEvents('2020-03-03').fomc).toBe(false)
  expect(calendarEvents('2024-11-07').fomc).toBe(true)
  expect(calendarEvents('2025-08-22').fomc).toBe(false)
  expect(calendarEvents('2026-12-09').fomc).toBe(true)
  expect(calendarEvents('2026-11-25').holiday).toBe(true) // Still known at the last priced session.
  expect(calendarEvents('2026-11-27').holiday).toBe(false)
  expect(calendarEvents('2022-06-17').holiday).toBe(true)
  expect(calendarEvents('2021-06-18').holiday).toBe(false)
  expect(calendarEvents('2018-12-04').holiday).toBe(false)
  expect(calendarEvents('2018-12-06').turn).toBe(true) // Third December session after the known closure.
  expect(() => calendarEvents('2018-12-05')).toThrow('Not a registered exchange session')
  expect(() => calendarEvents('2025-01-09')).toThrow('Not a registered exchange session')
  expect(calendarEvents('2021-12-31').holiday).toBe(false) // Saturday New Year's Day not observed on Friday.
})

test('marks exactly T-1 through T+3 on the exit date and coalesces C–C without claiming time orthogonality', () => {
  const { daily, minutes } = fixture('2026-02-24', '2026-03-06')
  const make = formWindows(daily, minutes)
  const overnight = make(spy(Rule.TurnOvernight))
  expect(overnight.map(({ marks }) => daily[marks[0].i].date)).toEqual([
    '2026-02-26',
    '2026-02-27',
    '2026-03-02',
    '2026-03-03',
    '2026-03-04',
  ])
  expect(regularSessionOverlap(daily, overnight)).toBe(0)
  const closeToClose = make(spy(Rule.TurnCloseToClose))
  expect(closeToClose).toHaveLength(1)
  expect(closeToClose[0].marks).toHaveLength(5)
  expect(regularSessionOverlap(daily, closeToClose)).toBe(5 * 390)
  expect(replay(daily, closeToClose, 5).flatMap(({ closedPnl }) => closedPnl)).toHaveLength(1)
})

test('pre-holiday overnight exits at the open of the actual short session; the literal last session overlaps', () => {
  const { daily, minutes } = fixture('2024-07-01', '2024-07-05')
  const make = formWindows(daily, minutes)
  const [overnight] = make(spy(Rule.HolidayOvernight))
  const [literal] = make(spy(Rule.HolidaySession))
  expect(overnight.entryAt).toBe(daily[1].closeAt)
  expect(overnight.exitAt).toBe(daily[2].openAt)
  expect(regularSessionOverlap(daily, [overnight])).toBe(0)
  expect(literal.exitAt).toBe(daily[2].closeAt)
  expect(regularSessionOverlap(daily, [literal])).toBe(210)
})

test('24h FOMC diagnostic uses the pre-statement mark, attributes both dates, and refuses a missing mark', () => {
  const { daily, minutes } = fixture('2025-01-27', '2025-01-30')
  const entry = Array<Bar | undefined>(78).fill(undefined)
  entry[54] = makeBar(100)
  entry[77] = makeBar(102)
  const exit = Array<Bar | undefined>(78).fill(undefined)
  exit[53] = makeBar(103)
  exit[54] = makeBar(1_000) // First post-announcement bar must never set the exit.
  minutes[1] = { ...minutes[1], bars: new Map([['SPY', entry]]) }
  minutes[2] = { ...minutes[2], bars: new Map([['SPY', exit]]) }
  const make = formWindows(daily, minutes)
  const [window] = make(spy(Rule.Fomc24h))
  expect(window.exitAt - window.entryAt).toBe(24 * 60 * 60_000)
  expect(regularSessionOverlap(daily, [window])).toBe(390)
  expect(regularSessionOverlap(daily, make(spy(Rule.FomcOvernight)))).toBe(0)
  const path = replay(daily, [window], 0)
  expect(path[1].net).toBeCloseTo(0.02, 12)
  expect(path[1].closedPnl).toEqual([])
  expect(path[2].closedPnl).toHaveLength(1)
  expect(
    wealth(
      path.map(({ net }) => net),
      true,
    ),
  ).toBeCloseTo(1.03 * (1 - sellFeeBps / 10_000), 12)
  exit[53] = undefined
  expect(() => make(spy(Rule.Fomc24h))).toThrow('Missing or invalid 5m slot 53 close: SPY 2025-01-29')
  expect(() => formWindows(daily, minutes.slice(1))).toThrow('Session count mismatch')
})

test('H4 merges coincident signals and uses only closes before the entry session for sizing and filtering', () => {
  const exitDate = '2024-05-01' // Both FOMC and T+1.
  const entryDate = '2024-04-30'
  const make = (shock?: string) =>
    fixture('2024-01-02', exitDate, (date, i) => [i % 2 === 0 ? 99 : 101, date === shock ? 200 : 100])
  const endingWindows = ({ daily, minutes }: ReturnType<typeof make>) =>
    formWindows(daily, minutes)(candidate).filter(({ exitAt }) => exitAt === daily.at(-1)?.openAt)
  const normal = make()
  const windows = endingWindows(normal)
  expect(windows).toHaveLength(1)
  expect(windows[0].entry).toHaveLength(5)
  expect(windows[0].weight).toBeGreaterThan(0)
  expect(windows[0].weight).toBeLessThan(1)
  expect(regularSessionOverlap(normal.daily, windows)).toBe(0)
  expect(endingWindows(make(entryDate))[0].weight).toBe(windows[0].weight)
  expect(endingWindows(make('2024-04-29'))).toEqual([])
})

test('reports funded two-sided costs, trade P&L, turnover and a compounded breakeven', () => {
  const dates = [{ date: '2026-01-02' }, { date: '2026-01-05' }]
  const window: Window = { entryAt: 1, exitAt: 2, weight: 1, entry: [100], marks: [{ i: 1, prices: [101] }] }
  const path = replay(dates, [window], 10)
  const funded = 1 / 1.0005
  const expected = funded * 1.01 * (1 - 0.0005 - 0.000021) - 1
  expect(path[1].net).toBeCloseTo(expected, 12)
  expect(path[1].turnover).toBeCloseTo((funded * (1 + 1.01)) / 2, 12)
  expect(path[1].closedPnl[0]).toBeCloseTo(expected, 12)
  expect(performance(path).netReturn).toBeCloseTo(expected, 12)
  const root = breakevenBps([window])
  expect(root).not.toBeNull()
  expect(root).toBeCloseTo((20_000 * (1.01 * (1 - 0.000021) - 1)) / 2.01, 7)
  expect(breakevenBps([{ ...window, marks: [{ i: 1, prices: [100] }] }])).toBeNull()
  expect(tradeStatistics([0.05, -0.02, 0])).toEqual({ tradeCount: 3, winRate: 1 / 3, profitFactor: 2.5 })
  expect(() => replay(dates, [window, window], 0)).toThrow('disjoint')
})

test('all registered trials are unique; missing or boundary evidence cannot pass the verdict gates', () => {
  expect(trials).toHaveLength(31)
  expect(new Set(trials.map(({ id }) => id)).size).toBe(31)
  const correlation = { SPY: 0.2, F4: 0.1, O1: -0.2, B0: 0 }
  const input = {
    fullSharpe: 0.75,
    holdoutSharpe: 0.8,
    holdoutDsr: 0.95,
    holdoutP: 0.04,
    splitReturns: [0.1, 0.02, 0.1],
    positiveYears: 7,
    overlapMinutes: 0,
    fullCorrelation: correlation,
    holdoutCorrelation: correlation,
    additive: Array.from({ length: 3 }, () => ({
      fullSharpeLift: 0.15,
      sharpeLift: 0.15,
      holdoutNetLift: 0.02,
      pIncrementalMean: 0.04,
    })),
  }
  expect(Object.values(gates(input)).every(Boolean)).toBe(true)
  expect(gates({ ...input, fullCorrelation: { ...correlation, B0: null } }).lowCorrelation).toBe(false)
  expect(gates({ ...input, holdoutCorrelation: { ...correlation, B0: -0.25 } }).lowCorrelation).toBe(false)
  expect(gates({ ...input, holdoutDsr: null }).inference).toBe(false)
  expect(gates({ ...input, holdoutP: 0.05 }).inference).toBe(false)
  expect(gates({ ...input, splitReturns: [0.1, 0.0, 0.1] }).stability).toBe(false)
  expect(gates({ ...input, overlapMinutes: 1 }).zeroRegularSessionOverlap).toBe(false)
  expect(gates({ ...input, additive: [] }).additive).toBe(false)
  expect(gates({ ...input, additive: input.additive.map((row) => ({ ...row, holdoutNetLift: -0.01 })) }).additive).toBe(
    false,
  )
})
