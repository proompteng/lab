import { canonicalHashV1 } from '../../hash'
import type { IntradaySnapshotRequest } from '../../market-data'
import type { ArchiveVerifiedIntradayMarketSnapshot } from '../../market-data/intraday/model'
import { utcInstantFromEpochMillis } from '../../time'
import type { IntradayMomentumProtocol } from './protocol'

export const intradayTestArchiveTopics = Object.freeze({
  bars: 'torghut.bars.1m.v1',
  quotes: 'torghut.quotes.v1',
  trades: 'torghut.trades.v1',
} as const)

export const makeIntradayMomentumTestSnapshot = (
  protocol: Pick<IntradayMomentumProtocol, 'delayClass' | 'feed' | 'universe' | 'universeId' | 'universeSymbolHash'>,
  request: IntradaySnapshotRequest,
  premiums: Readonly<Record<string, number>> = {},
  basePrice = 100,
  bidSizes: Readonly<Record<string, number>> = {},
): ArchiveVerifiedIntradayMarketSnapshot => {
  const rangeStartEpoch = Date.parse(request.rangeStartAt)
  const rangeMinutes = (Date.parse(request.rangeEndAt) - rangeStartEpoch) / 60_000
  const requestedSymbols = request.symbols ?? request.universe
  const identity = (
    symbol: string,
    sourceTopic: string,
    sourceOffset: number,
    eventAt: string,
    ingestedAt: string = request.observedAt,
  ) => ({
    provider: 'alpaca' as const,
    universeId: protocol.universeId,
    universeSymbolHash: protocol.universeSymbolHash,
    feed: protocol.feed,
    marketSession: 'regular' as const,
    delayClass: protocol.delayClass,
    symbol,
    eventAt,
    ingestedAt,
    sourceTopic,
    sourcePartition: 0,
    sourceOffset: String(sourceOffset),
    schemaVersion: 1 as const,
  })
  const compareRecords = (left: { eventAt: string; symbol: string }, right: { eventAt: string; symbol: string }) =>
    left.eventAt.localeCompare(right.eventAt) || left.symbol.localeCompare(right.symbol)
  const quoteOnly = request.purpose !== undefined
  const bars = quoteOnly
    ? []
    : requestedSymbols
        .flatMap((symbol, symbolIndex) =>
          Array.from({ length: rangeMinutes }, (_, minute) => ({
            ...identity(
              symbol,
              intradayTestArchiveTopics.bars,
              symbolIndex * rangeMinutes + minute + 1,
              utcInstantFromEpochMillis(rangeStartEpoch + minute * 60_000),
              utcInstantFromEpochMillis(rangeStartEpoch + (minute + 1) * 60_000),
            ),
            channel: 'bars' as const,
            final: true,
            open: basePrice,
            high: basePrice * 1.01,
            low: basePrice * 0.99,
            close: basePrice,
            volume: 1_000,
            vwap: basePrice,
            tradeCount: '100',
          })),
        )
        .toSorted(compareRecords)
  const quoteAt = utcInstantFromEpochMillis(Date.parse(request.observedAt) - 1_000)
  const halfSpread = basePrice * 0.0001
  const quotes = requestedSymbols
    .map((symbol, index) => {
      const midpoint = basePrice * (1 + (premiums[symbol] ?? 0))
      return {
        ...identity(symbol, intradayTestArchiveTopics.quotes, index + 1, quoteAt, quoteAt),
        bidPrice: midpoint - halfSpread,
        bidSize: bidSizes[symbol] ?? 100,
        askPrice: midpoint + halfSpread,
        askSize: 100,
      }
    })
    .toSorted(compareRecords)
  const trades = quoteOnly
    ? []
    : requestedSymbols
        .map((symbol, index) => {
          const price = basePrice * (1 + (premiums[symbol] ?? 0))
          return {
            ...identity(symbol, intradayTestArchiveTopics.trades, index + 1, quoteAt, quoteAt),
            price,
            size: 10,
          }
        })
        .toSorted(compareRecords)
  const lineage = [
    { sourceTopic: intradayTestArchiveTopics.bars, recordCount: bars.length },
    { sourceTopic: intradayTestArchiveTopics.quotes, recordCount: quotes.length },
    { sourceTopic: intradayTestArchiveTopics.trades, recordCount: trades.length },
  ]
    .filter(({ recordCount }) => recordCount > 0)
    .sort((left, right) => left.sourceTopic.localeCompare(right.sourceTopic))
    .map(({ sourceTopic, recordCount }) => ({
      sourceTopic,
      sourcePartition: 0,
      firstOffset: '1',
      lastOffset: String(recordCount),
      recordCount,
    }))
  const material = {
    schemaVersion: 'bayn.intraday-market-snapshot.v1' as const,
    sessionDate: request.sessionDate,
    calendar: request.calendar,
    rangeStartAt: request.rangeStartAt,
    rangeEndAt: request.rangeEndAt,
    observedAt: request.observedAt,
    universeId: request.universeId,
    universeSymbolHash: request.universeSymbolHash,
    ...(request.symbols === undefined ? {} : { universe: [...request.universe].sort() }),
    symbols: [...requestedSymbols].sort(),
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    feed: request.feed,
    delayClass: request.delayClass,
    sourceTopics: request.sourceTopics,
    archiveWatermarks: [...request.archiveWatermarks].sort((left, right) =>
      left.sourceTopic.localeCompare(right.sourceTopic),
    ),
    maximumQuoteAgeMs: request.maximumQuoteAgeMs,
    minimumWatermarkLagMs: request.minimumWatermarkLagMs,
    barCount: bars.length,
    quoteCount: quotes.length,
    tradeCount: trades.length,
    barsContentHash: canonicalHashV1(bars),
    quotesContentHash: canonicalHashV1(quotes),
    tradesContentHash: canonicalHashV1(trades),
    lineage,
  }
  const contentHash = canonicalHashV1(material)
  return {
    bars,
    quotes,
    trades,
    latestQuotes: Object.fromEntries(quotes.map((quote) => [quote.symbol, quote])),
    manifest: {
      ...material,
      contentHash,
      snapshotId: canonicalHashV1({ ...material, contentHash }),
    },
  } as unknown as ArchiveVerifiedIntradayMarketSnapshot
}
