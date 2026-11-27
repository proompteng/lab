import { DateTime, Effect, Result } from 'effect'

import { accountTradingDate, utcInstantFromEpochMillis } from '../../src/time'
import type { Alpaca, Bar, BarsPage, Calendar, MarketClock } from './alpaca'
import { failure } from './contract'
import { anchorDate, etfs, historyLength, macroInputs, type Etf, type Session } from './signals'

const timeZone = 'America/New_York'
const dayMs = 86_400_000
const minuteMs = 60_000
const clockToleranceMs = minuteMs

export const nyTime = (date: string, time: string) =>
  DateTime.toEpochMillis(DateTime.makeZonedUnsafe(`${date}T${time}:00Z`, { timeZone, adjustForTimeZone: true }))

const calendarWindow = (calendar: Calendar, clock: MarketClock, now: number) =>
  Result.gen(function* () {
    const observedAt = Date.parse(clock.timestamp)
    const nextOpen = Date.parse(clock.next_open)
    if (clock.is_open || Math.abs(now - observedAt) > clockToleranceMs || nextOpen <= now)
      return yield* Result.fail(failure('calendar', 'Stale market clock or no upcoming regular-session open'))
    if (
      calendar[0]?.date !== anchorDate ||
      calendar.some((s, i) => s.open >= s.close || (i > 0 && calendar[i - 1].date >= s.date))
    )
      return yield* Result.fail(failure('calendar', 'Invalid or incomplete anchored trading calendar'))

    const nextIndex = calendar.findIndex((s) => nyTime(s.date, s.open) > now)
    const next = calendar[nextIndex]
    const last = calendar[nextIndex - 1]
    if (
      next === undefined ||
      last === undefined ||
      nextIndex < historyLength ||
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
      olderDates: calendar.slice(0, nextIndex - historyLength).map((s) => s.date),
      recentDates: calendar.slice(nextIndex - historyLength, nextIndex).map((s) => s.date),
      lastDate: last.date,
      lastCloseAt: utcInstantFromEpochMillis(lastClose),
      barEnd: utcInstantFromEpochMillis(nyTime(next.date, '00:00') - 1),
      executionDate: next.date,
      executionOpenAt: utcInstantFromEpochMillis(nextOpen),
      cutoff,
    }
  })

export const readWindow = Effect.fn('macro-canary.calendar')(function* (alpaca: Alpaca, now: number) {
  const end = accountTradingDate(utcInstantFromEpochMillis(now + 7 * dayMs))
  const calendar = yield* alpaca.calendar(anchorDate, end)
  if (calendar.some((s) => s.date > end || s.date < anchorDate))
    return yield* failure('calendar', 'Calendar returned dates outside the requested range')
  const clock = yield* alpaca.clock()
  return yield* Effect.fromResult(calendarWindow(calendar, clock, now))
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

const readBars = Effect.fn('macro-canary.daily-bars')(function* <S extends Etf>(
  alpaca: Alpaca,
  symbols: readonly S[],
  dates: readonly string[],
  end: string,
  adjustment: 'all' | 'raw',
) {
  const bySymbol = new Map(symbols.map((symbol) => [symbol, new Map<number, Bar>()]))
  if (dates.length === 0) return bySymbol
  const expected = dates.map((date) => nyTime(date, '00:00'))
  const expectedSet = new Set(expected)
  const tokens = new Set<string>()
  let pageToken: string | null = null
  do {
    const page: BarsPage = yield* alpaca.bars({
      symbols: symbols.join(','),
      adjustment,
      start: utcInstantFromEpochMillis(expected[0]),
      end,
      pageToken,
    })
    for (const [symbol, rows] of Object.entries(page.bars)) {
      const known = symbols.find((candidate) => candidate === symbol)
      const bars = known === undefined ? undefined : bySymbol.get(known)
      if (bars === undefined) return yield* failure('bars', 'SIP returned an unrequested symbol')
      for (const bar of rows) {
        const t = Date.parse(bar.t)
        if (
          !expectedSet.has(t) ||
          bars.has(t) ||
          bar.l > Math.min(bar.o, bar.c) ||
          bar.h < Math.max(bar.o, bar.c) ||
          bar.v <= 0
        )
          return yield* failure(
            'bars',
            `Invalid, incomplete, duplicate or unexpected ${adjustment} SIP bar for ${symbol}`,
          )
        bars.set(t, bar)
      }
    }
    pageToken = page.next_page_token
    if (pageToken !== null) {
      if (tokens.has(pageToken) || tokens.size >= 63)
        return yield* failure('bars', 'SIP pagination did not terminate within its bound')
      tokens.add(pageToken)
    }
  } while (pageToken !== null)

  for (const [symbol, bars] of bySymbol)
    if (bars.size !== dates.length) {
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
  const recent = yield* readBars(alpaca, etfs, window.recentDates, window.barEnd, 'all')
  const raw = yield* readBars(alpaca, etfs, [window.lastDate], window.barEnd, 'raw')
  const older = yield* readBars(
    alpaca,
    macroInputs,
    window.olderDates,
    utcInstantFromEpochMillis(nyTime(window.recentDates[0], '00:00') - 1),
    'all',
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
    recent: closeSessions(window.recentDates, recent),
    older: closeSessions(window.olderDates, older),
  }
})
