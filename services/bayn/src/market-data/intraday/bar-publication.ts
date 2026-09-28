import type { IntradayBar } from './model'
import { intradayInstantNanos } from './time'

export enum BarPublicationPolicy {
  LegacyQuoteAge = 'legacy-quote-age',
  TimelyEquivalentRevision = 'timely-equivalent-revision.v1',
}

// Alpaca publishes originals after the minute and corrections at the following half minute.
// Delivery allowance is independent of the executable quote-age policy.
export const maximumBarPublicationDelayMs = (bar: IntradayBar): number =>
  (bar.delayClass === 'delayed_15m_consolidated' ? 900_000 : 0) +
  (bar.channel === 'updatedBars' ? 90_000 : 60_000) +
  10_000

export const sameBarMarketValues = (a: IntradayBar, b: IntradayBar): boolean =>
  a.provider === b.provider &&
  a.universeId === b.universeId &&
  a.universeSymbolHash === b.universeSymbolHash &&
  a.feed === b.feed &&
  a.marketSession === b.marketSession &&
  a.delayClass === b.delayClass &&
  a.symbol === b.symbol &&
  intradayInstantNanos(a.eventAt) === intradayInstantNanos(b.eventAt) &&
  a.final === b.final &&
  a.schemaVersion === b.schemaVersion &&
  a.sourceTopic === b.sourceTopic &&
  Object.is(a.open, b.open) &&
  Object.is(a.high, b.high) &&
  Object.is(a.low, b.low) &&
  Object.is(a.close, b.close) &&
  Object.is(a.volume, b.volume) &&
  Object.is(a.vwap, b.vwap) &&
  a.tradeCount === b.tradeCount
