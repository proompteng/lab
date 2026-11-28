import { Schema } from 'effect'

import { EtfSchema } from '../../src/strategy/macro-etf-core/policy'
import type { Day as MinuteSession, Symbol as MinuteSymbol } from '../noise-area-study-replay'
import { elapsedDays, requireAlignedSessions } from '../research-lib/calendar'
import { mean, sum, wealth } from '../research-lib/statistics'
import { calendarEvents } from './event-calendar-etf-calendar'
import type { DailyFrame } from './macro-etf-core-dual-horizon-data'

export const symbols = ['SPY', 'QQQ', 'TLT', 'GLD', 'IWM'] as const
type Symbol = (typeof symbols)[number]

export enum Rule {
  TurnOvernight = 'H1-overnight',
  TurnCloseToClose = 'H1-close-to-close',
  FomcOvernight = 'H2-overnight',
  Fomc24h = 'H2-24h',
  HolidayOvernight = 'H3-overnight',
  HolidaySession = 'H3-open-to-close',
  Composite = 'H4-composite',
}

export const TrialSchema = Schema.Struct({
  id: Schema.String,
  rule: Schema.Enum(Rule),
  symbols: Schema.Array(EtfSchema),
})

export const candidate = { id: Rule.Composite, rule: Rule.Composite, symbols }
export const trials = [
  ...Object.values(Rule)
    .filter((rule) => rule !== Rule.Composite)
    .flatMap((rule) => symbols.map((symbol) => ({ id: `${rule}/${symbol}`, rule, symbols: [symbol] }))),
  candidate,
] satisfies readonly (typeof TrialSchema.Type)[]
type Trial = (typeof trials)[number]

export const risk = { lookback: 60, targetVol: 0.08, spyLookback: 20, spyVolCeiling: 0.25 } as const
export const sellFeeBps = 0.21
const minuteMs = 60_000
const fomcSlot = (14 * 60 - (9 * 60 + 30)) / 5

export interface Window {
  readonly entryAt: number
  readonly exitAt: number
  readonly weight: number
  readonly entry: readonly number[]
  readonly marks: readonly { readonly i: number; readonly prices: readonly number[] }[]
}

export interface DailyReturn {
  readonly date: string
  readonly net: number
  readonly turnover: number
}

export const annualVol = (values: readonly number[]) => {
  if (values.length < 2) throw new Error('Volatility requires two observations')
  const center = mean(values)
  return Math.sqrt((252 * sum(values.map((value) => (value - center) ** 2))) / (values.length - 1))
}

const requirePrice = (price: number | undefined, symbol: string, date: string, mark: string) => {
  if (price === undefined || !Number.isFinite(price) || price <= 0)
    throw new Error(`Missing or invalid ${mark}: ${symbol} ${date}`)
  return price
}

const price = (day: DailyFrame, symbol: Symbol, mark: 'open' | 'close') =>
  requirePrice(day.bars.get(symbol)?.[mark], symbol, day.date, mark)

const minutePrice = (day: MinuteSession, symbol: MinuteSymbol, slot: number, mark: 'open' | 'close') =>
  requirePrice(day.bars.get(symbol)?.[slot]?.[mark], symbol, day.date, `5m slot ${slot} ${mark}`)

export const formWindows = (daily: readonly DailyFrame[], minutes: readonly MinuteSession[]) => {
  requireAlignedSessions(daily, minutes)
  const flags = daily.map(({ date }) => calendarEvents(date))
  const overnight = daily
    .slice(1)
    .map((day, i) => mean(symbols.map((s) => price(day, s, 'open') / price(daily[i], s, 'close') - 1)))
  const spyClose = daily.slice(1).map((day, i) => price(day, 'SPY', 'close') / price(daily[i], 'SPY', 'close') - 1)

  const basketWeight = (exitIndex: number) => {
    // First daily return is at index 1. At the entry close (i-1), only closes
    // through i-2 are available for decisions submitted ahead of the auction.
    const end = exitIndex - 2
    if (end < risk.lookback || annualVol(spyClose.slice(end - risk.spyLookback, end)) > risk.spyVolCeiling) return 0
    const vol = annualVol(overnight.slice(end - risk.lookback, end))
    return vol > 0 ? Math.min(1, risk.targetVol / vol) : 0
  }

  return ({ rule, symbols: members }: Trial) => {
    const windows: Window[] = []
    for (let i = 1; i < daily.length; i++) {
      const day = daily[i]
      const prior = daily[i - 1]
      const { turn, fomc, holiday } = flags[i]
      const closes = (frame: DailyFrame) => members.map((s) => price(frame, s, 'close'))
      const opens = (frame: DailyFrame) => members.map((s) => price(frame, s, 'open'))
      if (rule === Rule.TurnCloseToClose && turn) {
        let end = i
        while (flags[end + 1]?.turn === true) end++
        windows.push({
          entryAt: prior.closeAt,
          exitAt: daily[end].closeAt,
          weight: 1,
          entry: closes(prior),
          marks: daily.slice(i, end + 1).map((frame, j) => ({ i: i + j, prices: closes(frame) })),
        })
        i = end
      } else if (rule === Rule.Fomc24h && fomc) {
        if (elapsedDays(prior.date, day.date) !== 1 || minutes[i - 1].slots <= fomcSlot || minutes[i].slots <= fomcSlot)
          throw new Error(`No regular session at both 14:00 marks: ${day.date}`)
        windows.push({
          entryAt: prior.openAt + fomcSlot * 5 * minuteMs,
          exitAt: day.openAt + fomcSlot * 5 * minuteMs,
          weight: 1,
          entry: members.map((s) => minutePrice(minutes[i - 1], s, fomcSlot, 'open')),
          marks: [
            { i: i - 1, prices: members.map((s) => minutePrice(minutes[i - 1], s, minutes[i - 1].slots - 1, 'close')) },
            // The bar ending at 14:00 ET cannot include the bar opening on the statement.
            { i, prices: members.map((s) => minutePrice(minutes[i], s, fomcSlot - 1, 'close')) },
          ],
        })
      } else if (rule === Rule.HolidaySession && holiday) {
        windows.push({
          entryAt: day.openAt,
          exitAt: day.closeAt,
          weight: 1,
          entry: opens(day),
          marks: [{ i, prices: closes(day) }],
        })
      } else if (
        (rule === Rule.TurnOvernight && turn) ||
        (rule === Rule.FomcOvernight && fomc) ||
        (rule === Rule.HolidayOvernight && holiday) ||
        (rule === Rule.Composite && (turn || fomc || holiday))
      ) {
        const weight = rule === Rule.Composite ? basketWeight(i) : 1
        if (weight > 0)
          windows.push({
            entryAt: prior.closeAt,
            exitAt: day.openAt,
            weight,
            entry: closes(prior),
            marks: [{ i, prices: opens(day) }],
          })
      }
    }
    return windows
  }
}

export const regularSessionOverlap = (daily: readonly DailyFrame[], windows: readonly Window[]) =>
  sum(
    windows.map(({ entryAt, exitAt, marks }) => {
      const last = marks.at(-1)
      if (last === undefined || entryAt >= exitAt) throw new Error('Invalid holding interval')
      return (
        sum(
          daily
            .slice(Math.max(0, marks[0].i - 1), last.i + 1)
            .map(({ openAt, closeAt }) => Math.max(0, Math.min(exitAt, closeAt) - Math.max(entryAt, openAt))),
        ) / minuteMs
      )
    }),
  )

const funded = (window: Window, sideRate: number) => window.weight / window.entry.length / (1 + sideRate)
const navAfterExit = (window: Window, prices: readonly number[], sideRate: number) =>
  1 -
  window.weight +
  funded(window, sideRate) *
    sum(prices.map((price, j) => price / window.entry[j])) *
    (1 - sideRate - sellFeeBps / 10_000)

export const replay = (
  daily: readonly { readonly date: string }[],
  windows: readonly Window[],
  roundTripBps: number,
) => {
  const rows = daily.map(({ date }) => ({ date, net: 0, turnover: 0, closedPnl: [] as number[] }))
  const slip = roundTripBps / 20_000
  let capital = 1
  let lastMark = -1
  for (const window of windows) {
    const { weight, entry, marks } = window
    if (!(weight > 0 && weight <= 1) || entry.length === 0 || marks.length === 0)
      throw new Error('Invalid round-trip allocation')
    const notionalPerLeg = funded(window, slip)
    let prior = 1
    for (const [step, { i, prices }] of marks.entries()) {
      if (i <= lastMark || (step > 0 && i !== lastMark + 1) || prices.length !== entry.length || rows[i] === undefined)
        throw new Error('Round-trip marks must be disjoint and complete')
      lastMark = i
      const values = prices.map((price, j) => (notionalPerLeg * price) / entry[j])
      const entryNotional = step === 0 ? notionalPerLeg * entry.length : 0
      const exit = step === marks.length - 1
      const exitNotional = exit ? sum(values) : 0
      const nav = exit ? navAfterExit(window, prices, slip) : 1 - weight + sum(values)
      if (!(Number.isFinite(nav) && nav > 0)) throw new Error('Invalid marked strategy equity')
      rows[i].net = nav / prior - 1
      rows[i].turnover = (entryNotional + exitNotional) / (2 * prior)
      if (exit)
        rows[i].closedPnl = values.map(
          (value) => capital * (value * (1 - slip - sellFeeBps / 10_000) - weight / entry.length),
        )
      prior = nav
    }
    capital *= prior
  }
  return rows
}

export const breakevenBps = (windows: readonly Window[]) => {
  const terminal = (bp: number) =>
    wealth(
      windows.map((window) => {
        const exit = window.marks.at(-1)
        if (exit === undefined) throw new Error('Missing exit mark')
        return navAfterExit(window, exit.prices, bp / 20_000) - 1
      }),
      true,
    )
  if (terminal(0) <= 1) return null
  let low = 0
  let high = 10_000
  if (terminal(high) > 1) throw new Error('Breakeven slippage not bracketed')
  for (let i = 0; i < 42; i++) {
    const mid = (low + high) / 2
    if (terminal(mid) > 1) low = mid
    else high = mid
  }
  return (low + high) / 2
}
