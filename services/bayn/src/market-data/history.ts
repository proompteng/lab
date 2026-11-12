import { MarketKind } from '../instruments'

export const marketQuoteMaximumAgeMs = 10_000

// Chart context is independent of the holding horizon and the producer's rolling indicators.
export const marketHistoryMinutes = Object.freeze({
  [MarketKind.Equity]: 30,
  [MarketKind.Crypto]: 120,
} as const)
