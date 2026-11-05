import { instrumentMarket, MarketKind } from '../instruments'
import { OrderSide, type Intent } from './contracts'

/** Current entry scope is narrower than the retained capital mandate. */
export const currentEntryMarkets: readonly MarketKind[] = Object.freeze([MarketKind.Equity])

export const currentEntryMarketEnabled = (market: MarketKind): boolean => currentEntryMarkets.includes(market)

/** Existing long positions may still exit through all normal ownership, risk and capital checks. */
export const currentSubmissionMarketAllowed = (intent: Pick<Intent, 'symbol' | 'side'>): boolean =>
  currentEntryMarketEnabled(instrumentMarket(intent.symbol)) || intent.side === OrderSide.Sell
