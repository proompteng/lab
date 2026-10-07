import type { IntradayQuote } from '../market-data/intraday/model'

export enum JevQuoteReferenceScope {
  ExchangeOnly = 'IEX_EXCHANGE_ONLY_NOT_NBBO',
  Consolidated = 'SIP_CONSOLIDATED',
  DelayedConsolidated = 'DELAYED_SIP_NOT_CURRENT_NBBO',
}

const referenceScopes: Readonly<Record<IntradayQuote['feed'], JevQuoteReferenceScope>> = {
  iex: JevQuoteReferenceScope.ExchangeOnly,
  sip: JevQuoteReferenceScope.Consolidated,
  delayed_sip: JevQuoteReferenceScope.DelayedConsolidated,
}

/** Diagnostic metadata only. A venue quote cannot establish a consolidated loss or a guaranteed exit price. */
export const jevProtectiveQuoteDiagnostics = (
  quote: Pick<IntradayQuote, 'feed' | 'eventAt' | 'bidPrice' | 'askPrice'>,
  entrySpreadLimitBps: number,
) => ({
  schemaVersion: 'bayn.jev-protective-quote-diagnostics.v1' as const,
  referenceScope: referenceScopes[quote.feed],
  feed: quote.feed,
  pairedFeedComparisonAvailable: false,
  quoteEventAt: quote.eventAt,
  // Approximate display statistic, never used to admit, reject or size an exit.
  spreadBpsApprox: ((quote.askPrice - quote.bidPrice) / (quote.askPrice / 2 + quote.bidPrice / 2)) * 10_000,
  entrySpreadLimitBps,
})
