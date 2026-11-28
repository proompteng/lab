import { MarketKind } from '../instruments'

export const marketQuoteMaximumAgeMs = 10_000

// Chart context is independent of the holding horizon and the producer's rolling indicators.
export const marketHistoryMinutes = Object.freeze({
  [MarketKind.Equity]: 30,
  [MarketKind.Crypto]: 120,
} as const)

// Regular US equity sessions run 390 minutes (09:30–16:00 ET). Retaining the full
// session of 1m bars enables opening-range and session-VWAP signals without gap loss.
export const equitySessionHistoryMinutes = 390
export const equityRetainedBarMinutes = equitySessionHistoryMinutes + 1
