import { DateTime, Effect, Result } from 'effect'

import { accountTradingDate, utcInstantFromEpochMillis } from '../../src/time'
import { BarAdjustment, type Alpaca, type Bar, type BarsPage, type Calendar, type MarketClock } from './alpaca'
import { failure } from './contract'
import { anchorDate, etfs, historyLength, macroInputs, type Etf, type Session } from './signals'

const timeZone = 'America/New_York'
const dayMs = 86_400_000
const minuteMs = 60_000
const clockToleranceMs = minuteMs

export const nyTime = (date: string, time: string) =>
  DateTime.toEpochMillis(DateTime.makeZonedUnsafe(`${date}T${time}:00Z`, { timeZone, adjustForTimeZone: true }))

const calendarWindow = (calendar: Calendar, clock: MarketClock, now: number, anchor: string, minimumSessions: number) =>
  Result.gen(function* () {
    const observedAt = Date.parse(clock.timestamp)
    const nextOpen = Date.parse(clock.next_open)
    if (clock.is_open || Math.abs(now - observedAt) > clockToleranceMs || nextOpen <= now)
      return yield* Result.fail(failure('calendar', 'Stale market clock or no upcoming regular-session open'))
    if (
      calendar[0]?.date !== anchor ||
      calendar.some((s, i) => s.open >= s.close || (i > 0 && calendar[i - 1].date >= s.date))
    )
      return yield* Result.fail(failure('calendar', 'Invalid or incomplete anchored trading calendar'))

    const nextIndex = calendar.findIndex((s) => nyTime(s.date, s.open) > now)
    const next = calendar[nextIndex]
    const last = calendar[nextIndex - 1]
    if (
      next === undefined ||
      last === undefined ||
      nextIndex < minimumSessions ||
      nyTime(next.date, next.open) !== nextOpen
    )
      return yield* Result.fail(failure('calendar', 'Trading calendar does not corroborate the upcoming open'))
    const lastClose = nyTime(last.date, last.close)
    // Allow the SIP daily close to settle after extended trading, also on early-close dates.
    const readyAt = Math.max(lastClose + minuteMs, nyTime(last.date, '20:15'))
    const cutoff = nextOpen - 2 * minuteMs
    if (now < readyAt || now >= cutoff || nextOpen - lastClose > 7 * dayMs)
      return yield* Result.fail(failure('calendar', 'Outside the finalized-bar / next-open planning window'))

    return {
      sessions: calendar.slice(0, nextIndex + 1),
      lastDate: last.date,
      lastCloseAt: utcInstantFromEpochMillis(lastClose),
      barEnd: utcInstantFromEpochMillis(nyTime(next.date, '00:00') - 1),
      executionDate: next.date,
      executionOpenAt: utcInstantFromEpochMillis(nextOpen),
      cutoff,
    }
  })

export const readWindow = Effect.fn('macro-rebalance.calendar')(function* (
  alpaca: Alpaca,
  now: number,
  anchor = anchorDate,
  minimumSessions = historyLength,
) {
  const end = accountTradingDate(utcInstantFromEpochMillis(now + 7 * dayMs))
  const calendar = yield* alpaca.calendar(anchor, end)
  if (calendar.some((s) => s.date > end || s.date < anchor))
    return yield* failure('calendar', 'Calendar returned dates outside the requested range')
  const clock = yield* alpaca.clock()
  return yield* Effect.fromResult(calendarWindow(calendar, clock, now, anchor, minimumSessions))
})

export type Window = Effect.Success<ReturnType<typeof readWindow>>

export const assertSubmissionWindow = (window: Window, clock: MarketClock, now: number) =>
  Result.gen(function* () {
    if (
      now >= window.cutoff ||
      clock.is_open ||
      Math.abs(Date.parse(clock.timestamp) - now) > clockToleranceMs ||
      Date.parse(clock.next_open) !== Date.parse(window.executionOpenAt)
    )
      return yield* Result.fail(failure('paper-submit', 'No longer in the verified next-open submission window'))
  })

export const readBars = Effect.fn('macro-rebalance.daily-bars')(function* <S extends string>(
  alpaca: Alpaca,
  symbols: readonly S[],
  dates: readonly string[],
  end: string,
  adjustment: BarAdjustment,
  optional: ReadonlySet<S> = new Set(),
) {
  const bySymbol = new Map(symbols.map((symbol) => [symbol, new Map<number, Bar>()]))
  if (dates.length === 0) return bySymbol
  const expected = dates.map((date) => nyTime(date, '00:00'))
  const expectedSet = new Set(expected)
  const tokens = new Set<string>()
  const lastBySymbol = new Map<S, number>()
  let pageToken: string | null = null
  do {
    const page: BarsPage = yield* alpaca.bars({
      symbols: symbols.join(','),
      adjustment,
      start: utcInstantFromEpochMillis(expected[0]),
      end,
      pageToken,
    })
    let count = 0
    for (const [symbol, rows] of Object.entries(page.bars)) {
      const known = symbols.find((candidate) => candidate === symbol)
      if (known === undefined) return yield* failure('bars', 'SIP returned an unrequested symbol')
      const bars = bySymbol.get(known)
      if (bars === undefined) return yield* failure('bars', 'SIP returned an unrequested symbol')
      for (const bar of rows) {
        const t = Date.parse(bar.t)
        if (
          !expectedSet.has(t) ||
          t <= (lastBySymbol.get(known) ?? -Infinity) ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.0+)?Z$/.test(bar.t) ||
          bar.l > Math.min(bar.o, bar.c) ||
          bar.h < Math.max(bar.o, bar.c) ||
          bar.v <= 0
        )
          return yield* failure(
            'bars',
            `Invalid, incomplete, duplicate or unexpected ${adjustment} SIP bar for ${symbol}`,
          )
        bars.set(t, bar)
        lastBySymbol.set(known, t)
        count++
      }
    }
    pageToken = page.next_page_token
    if (count === 0 && (tokens.size > 0 || pageToken !== null))
      return yield* failure('bars', 'SIP pagination returned an empty continuation')
    if (pageToken !== null) {
      if (tokens.has(pageToken) || tokens.size >= 63)
        return yield* failure('bars', 'SIP pagination did not terminate within its bound')
      tokens.add(pageToken)
    }
  } while (pageToken !== null)

  for (const [symbol, bars] of bySymbol)
    if (!optional.has(symbol) && bars.size !== dates.length) {
      const missing = dates.find((_, i) => !bars.has(expected[i]))
      return yield* failure('bars', `Missing ${adjustment} SIP bar for ${symbol} on ${missing}`)
    }
  return bySymbol
})

const closeSessions = <S extends Etf>(dates: readonly string[], bars: ReadonlyMap<S, ReadonlyMap<number, Bar>>) =>
  dates.map((date): Session => {
    const timestamp = nyTime(date, '00:00')
    return {
      date,
      closes: new Map([...bars].map(([symbol, series]) => [symbol, series.get(timestamp)?.c ?? NaN])),
    }
  })

export const readMarket = Effect.fn('macro-canary.market')(function* (alpaca: Alpaca, window: Window) {
  const dates = window.sessions.slice(0, -1).map((s) => s.date)
  const recentDates = dates.slice(-historyLength)
  const olderDates = dates.slice(0, -historyLength)
  const recent = yield* readBars(alpaca, etfs, recentDates, window.barEnd, BarAdjustment.All)
  const raw = yield* readBars(alpaca, etfs, [window.lastDate], window.barEnd, BarAdjustment.Raw)
  const older = yield* readBars(
    alpaca,
    macroInputs,
    olderDates,
    utcInstantFromEpochMillis(nyTime(recentDates[0], '00:00') - 1),
    BarAdjustment.All,
  )
  const material = <S extends Etf>(bars: ReadonlyMap<S, ReadonlyMap<number, Bar>>) =>
    [...bars].map(([symbol, series]) => ({
      symbol,
      bars: [...series.values()].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)),
    }))
  return {
    material: {
      feed: 'sip',
      timeframe: '1Day',
      adjustment: 'all',
      recent: material(recent),
      macroSeed: material(older),
    },
    rawBars: material(raw).flatMap(({ symbol, bars }) => bars.map((bar) => ({ symbol, bar }))),
    recent: closeSessions(recentDates, recent),
    older: closeSessions(olderDates, older),
  }
})
