import { MarketKind } from '../instruments'
import { TimeInForce } from './contracts'

/** Alpaca extended equity orders require DAY; crypto supports IOC at every hour. */
export const cashSpotLimitTimeInForce = (market: MarketKind): TimeInForce.Day | TimeInForce.ImmediateOrCancel =>
  market === MarketKind.Equity ? TimeInForce.Day : TimeInForce.ImmediateOrCancel
