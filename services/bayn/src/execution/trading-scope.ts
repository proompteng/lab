import { MarketKind } from '../instruments'

/** Current entry scope is narrower than the retained capital mandate. */
export const currentEntryMarkets: readonly MarketKind[] = Object.freeze([MarketKind.Equity])

export const currentEntryMarketEnabled = (market: MarketKind): boolean => currentEntryMarkets.includes(market)
