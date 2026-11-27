import type { IsoDate } from '../../schemas'
import { defaultMacroCanaryEtfPolicy, macroCanaryEtfs, type MacroCanaryEtf } from './policy'
import type { MacroCanaryEtfMarket } from './signals'

export const fixtureCalendar = (count: number) => {
  const dates: IsoDate[] = []
  const date = new Date(defaultMacroCanaryEtfPolicy.policy.historyStartSession)
  while (dates.length < count) {
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString().slice(0, 10) as IsoDate)
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return dates
}

export const parityClose = (day: number, _symbol: MacroCanaryEtf, i: number) =>
  100 + (day * ((i % 7) - 3)) / 100 + (((day * (i + 11) + i * 17) % 71) + ((day * day + i) % 19)) / 100

export const fixtureMarket = (day: number, closeAt = parityClose): MacroCanaryEtfMarket => {
  const calendar = fixtureCalendar(day + 3)
  return {
    nextOpenSession: calendar[day + 1],
    calendar,
    history: {
      adjustment: 'all',
      corporateActionsThrough: calendar[day],
      bars: calendar.flatMap((session, index) =>
        macroCanaryEtfs.map((symbol, i) => {
          const close = closeAt(index, symbol, i)
          return { session, symbol, open: close, high: close + 1, low: close - 1, close, volume: 1_000_000 }
        }),
      ),
    },
  }
}

export const regimeClose = (day: number, symbol: MacroCanaryEtf) => {
  const goldilocks = { HYG: 110, IEF: 103, TLT: 104, DBC: 99, GLD: 99, UUP: 99, SPY: 107, QQQ: 109, XLK: 108 }
  const stagflation = { HYG: 93, IEF: 104, TLT: 95, DBC: 113, GLD: 110, UUP: 106 }
  const deflation = { HYG: 90, IEF: 111, TLT: 115, DBC: 90, GLD: 102, UUP: 99 }
  const prices: Partial<Record<MacroCanaryEtf, number>> =
    day < 220 ? {} : day <= 252 ? goldilocks : day < 281 ? stagflation : deflation
  return prices[symbol] ?? 100
}
