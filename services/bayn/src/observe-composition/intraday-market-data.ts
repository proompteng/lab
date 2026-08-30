import { Data, Effect, Result, Schema } from 'effect'

import { quantizeAlpacaLimitPriceMicros } from '../broker/alpaca-price'
import type { OperationalError } from '../errors'
import { MICROS, numberToMicros } from '../execution-model'
import {
  intradayAgeNanos,
  millisecondsAsNanos,
  type IntradayMarketDataService,
  type IntradayMarketSnapshot,
  type IntradaySnapshotQuery,
} from '../market-data'
import type { ArchiveVerifiedIntradayMarketSnapshot } from '../market-data/intraday/model'
import { strictParseOptions } from '../schemas'
import { ExecutionMarketDataBindingSchema, type ExecutionMarketDataBinding } from '../shadow-decision-contract'

export class IntradayMarketDataFailure extends Data.TaggedError('IntradayMarketDataFailure')<{
  readonly operation: 'entry-decision' | 'close-quote-not-ready' | 'prices' | 'binding'
  readonly message: string
  readonly cause?: unknown
}> {}

const failure = (
  operation: IntradayMarketDataFailure['operation'],
  message: string,
  cause?: unknown,
): IntradayMarketDataFailure => new IntradayMarketDataFailure({ operation, message, cause })

export const loadIntradaySnapshot = (
  marketData: IntradayMarketDataService,
  query: IntradaySnapshotQuery,
): Effect.Effect<ArchiveVerifiedIntradayMarketSnapshot, OperationalError> =>
  marketData
    .captureVersion(query)
    .pipe(Effect.flatMap((archiveWatermarks) => marketData.loadSnapshot({ ...query, archiveWatermarks })))

const decodeExecutionMarketDataBinding = Schema.decodeUnknownResult(
  ExecutionMarketDataBindingSchema,
  strictParseOptions,
)

export const executionMarketDataBinding = (
  snapshot: IntradayMarketSnapshot,
): Result.Result<ExecutionMarketDataBinding, IntradayMarketDataFailure> =>
  Result.mapError(
    decodeExecutionMarketDataBinding({
      schemaVersion:
        snapshot.manifest.universe === undefined
          ? 'bayn.execution-market-data-binding.v1'
          : 'bayn.execution-market-data-binding.v2',
      snapshotSchemaVersion: snapshot.manifest.schemaVersion,
      sessionDate: snapshot.manifest.sessionDate,
      calendar: snapshot.manifest.calendar,
      rangeStartAt: snapshot.manifest.rangeStartAt,
      rangeEndAt: snapshot.manifest.rangeEndAt,
      observedAt: snapshot.manifest.observedAt,
      universeId: snapshot.manifest.universeId,
      universeSymbolHash: snapshot.manifest.universeSymbolHash,
      ...(snapshot.manifest.universe === undefined ? {} : { universe: snapshot.manifest.universe }),
      symbols: snapshot.manifest.symbols,
      ...(snapshot.manifest.purpose === undefined ? {} : { purpose: snapshot.manifest.purpose }),
      feed: snapshot.manifest.feed,
      delayClass: snapshot.manifest.delayClass,
      sourceTopics: snapshot.manifest.sourceTopics,
      archiveWatermarks: snapshot.manifest.archiveWatermarks,
      maximumQuoteAgeMs: snapshot.manifest.maximumQuoteAgeMs,
      minimumWatermarkLagMs: snapshot.manifest.minimumWatermarkLagMs,
      barCount: snapshot.manifest.barCount,
      quoteCount: snapshot.manifest.quoteCount,
      tradeCount: snapshot.manifest.tradeCount,
      barsContentHash: snapshot.manifest.barsContentHash,
      quotesContentHash: snapshot.manifest.quotesContentHash,
      tradesContentHash: snapshot.manifest.tradesContentHash,
      lineage: snapshot.manifest.lineage,
      contentHash: snapshot.manifest.contentHash,
      snapshotId: snapshot.manifest.snapshotId,
    }),
    (cause) => failure('binding', 'verified intraday snapshot cannot form an execution binding', cause),
  )

export interface AdverseQuotePrices {
  readonly bidPriceMicros: Readonly<Record<string, string>>
  readonly askPriceMicros: Readonly<Record<string, string>>
}

export const adverseQuotePrices = (
  snapshot: IntradayMarketSnapshot,
  symbols: readonly string[],
): Result.Result<AdverseQuotePrices, IntradayMarketDataFailure> => {
  const bidPriceMicros: Record<string, string> = {}
  const askPriceMicros: Record<string, string> = {}
  for (const symbol of [...new Set(symbols)].sort()) {
    const quote = snapshot.latestQuotes[symbol]
    if (quote === undefined) {
      return Result.fail(failure('prices', `intraday snapshot has no verified quote for ${symbol}`))
    }
    const prices = Result.all({
      bid: numberToMicros(quote.bidPrice, `bid price for ${symbol}`),
      ask: numberToMicros(quote.askPrice, `ask price for ${symbol}`),
    })
    if (Result.isFailure(prices) || prices.success.bid <= 0n || prices.success.ask <= 0n) {
      return Result.fail(failure('prices', `quote for ${symbol} is outside the exact price domain`))
    }
    bidPriceMicros[symbol] = quantizeAlpacaLimitPriceMicros(prices.success.bid, 'DOWN').toString()
    askPriceMicros[symbol] = quantizeAlpacaLimitPriceMicros(prices.success.ask, 'UP').toString()
  }
  return Result.succeed({
    bidPriceMicros: Object.freeze(bidPriceMicros),
    askPriceMicros: Object.freeze(askPriceMicros),
  })
}

export const adverseClosingQuotePrices = (
  snapshot: IntradayMarketSnapshot,
  symbols: readonly string[],
): Result.Result<AdverseQuotePrices, IntradayMarketDataFailure> => {
  const maximumQuoteAge = millisecondsAsNanos(snapshot.manifest.maximumQuoteAgeMs)
  for (const symbol of [...new Set(symbols)].sort()) {
    const quote = snapshot.latestQuotes[symbol]
    if (quote === undefined) {
      return Result.fail(failure('close-quote-not-ready', `intraday snapshot has no verified quote for ${symbol}`))
    }
    const quoteAge = intradayAgeNanos(snapshot.manifest.observedAt, quote.eventAt)
    if (quoteAge < 0n || quoteAge > maximumQuoteAge) {
      return Result.fail(
        failure('close-quote-not-ready', `closing quote for ${symbol} is outside the freshness window`),
      )
    }
  }
  return adverseQuotePrices(snapshot, symbols)
}

export const requireFreshIntradayPositionQuotes = (
  snapshot: IntradayMarketSnapshot,
  positions: readonly { readonly symbol: string; readonly quantityMicros: string }[],
): Result.Result<void, IntradayMarketDataFailure> => {
  const maximumQuoteAge = millisecondsAsNanos(snapshot.manifest.maximumQuoteAgeMs)
  const entryUniverse = new Set(snapshot.manifest.symbols)
  for (const position of positions) {
    if (BigInt(position.quantityMicros) === 0n || !entryUniverse.has(position.symbol)) continue
    const quote = snapshot.latestQuotes[position.symbol]
    if (quote === undefined) {
      return Result.fail(failure('entry-decision', `existing position ${position.symbol} has no verified quote`))
    }
    const quoteAge = intradayAgeNanos(snapshot.manifest.observedAt, quote.eventAt)
    if (quoteAge < 0n || quoteAge > maximumQuoteAge) {
      return Result.fail(failure('entry-decision', `existing position ${position.symbol} has no fresh quote`))
    }
  }
  return Result.succeed(undefined)
}

export const maximumBuyQuantities = (
  snapshot: IntradayMarketSnapshot,
  targetWeights: Readonly<Record<string, number>>,
): Result.Result<Readonly<Record<string, string>>, IntradayMarketDataFailure> => {
  const quantities: Record<string, string> = {}
  for (const [symbol, targetWeight] of Object.entries(targetWeights).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (targetWeight === 0) {
      quantities[symbol] = '0'
      continue
    }
    const quote = snapshot.latestQuotes[symbol]
    if (quote === undefined) {
      return Result.fail(failure('entry-decision', `entry snapshot has no verified quote for ${symbol}`))
    }
    const quantity = numberToMicros(quote.askSize, `entry ask size for ${symbol}`)
    if (Result.isFailure(quantity)) {
      return Result.fail(
        failure(
          'entry-decision',
          `entry ask size for ${symbol} is outside the exact quantity domain`,
          quantity.failure,
        ),
      )
    }
    const displayedWholeShareQuantity = (quantity.success / MICROS) * MICROS
    if (displayedWholeShareQuantity === 0n) {
      quantities[symbol] = '0'
      continue
    }
    quantities[symbol] = displayedWholeShareQuantity.toString()
  }
  return Result.succeed(Object.freeze(quantities))
}
