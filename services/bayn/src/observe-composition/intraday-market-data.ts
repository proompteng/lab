import type { StrategyMarketSnapshot, VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { Data, Effect, Result, Schema } from 'effect'

import { quantizeInstrumentPriceMicros } from '../broker/alpaca-price'
import type { OperationalError } from '../errors'
import { priceNumberToMicros } from '../strategy/execution-model/fixed-point'
import { intradayAgeNanos, millisecondsAsNanos } from '../market-data/intraday/time'
import { type IntradayMarketDataService, type IntradaySnapshotQuery } from '../market-data/intraday/model'
import { strictParseOptions } from '../schemas'
import { withObservedStage } from '../telemetry'
import { ExecutionMarketDataBindingSchema, type ExecutionMarketDataBinding } from '../shadow-decision-contract'

export class IntradayMarketDataFailure extends Data.TaggedError('IntradayMarketDataFailure')<{
  readonly operation: 'entry-decision' | 'close-quote-not-ready' | 'prices' | 'binding'
  readonly message: string
  readonly cause?: unknown
  readonly symbol?: string
  readonly eventAt?: string
}> {}

const failure = (
  operation: IntradayMarketDataFailure['operation'],
  message: string,
  cause?: unknown,
): IntradayMarketDataFailure => new IntradayMarketDataFailure({ operation, message, cause })

export const loadIntradaySnapshot = (
  marketData: IntradayMarketDataService,
  query: IntradaySnapshotQuery,
): Effect.Effect<VerifiedStrategyMarketSnapshot, OperationalError> =>
  Effect.suspend(() => marketData.loadSnapshot(query)).pipe(
    withObservedStage('bayn.market-data.snapshot', { dependency: 'market-data', operation: query.purpose ?? 'signal' }),
  )

const decodeExecutionMarketDataBinding = Schema.decodeUnknownResult(
  ExecutionMarketDataBindingSchema,
  strictParseOptions,
)

export const executionMarketDataBinding = (
  snapshot: StrategyMarketSnapshot,
): Result.Result<ExecutionMarketDataBinding, IntradayMarketDataFailure> => {
  const { schemaVersion, ...material } = snapshot.manifest
  return Result.mapError(
    decodeExecutionMarketDataBinding({
      ...material,
      schemaVersion:
        schemaVersion === 'bayn.simulated-market-snapshot.v2'
          ? 'bayn.execution-market-data-binding.v4'
          : 'bayn.execution-market-data-binding.v3',
      snapshotSchemaVersion: schemaVersion,
    }),
    (cause) => failure('binding', 'streaming execution market data binding is invalid', cause),
  )
}

export interface AdverseQuotePrices {
  readonly bidPriceMicros: Readonly<Record<string, string>>
  readonly askPriceMicros: Readonly<Record<string, string>>
}

export const adverseQuotePrices = (
  snapshot: {
    readonly latestQuotes: Readonly<Record<string, { readonly bidPrice: number; readonly askPrice: number }>>
  },
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
      bid: priceNumberToMicros(quote.bidPrice, `bid price for ${symbol}`, 'DOWN'),
      ask: priceNumberToMicros(quote.askPrice, `ask price for ${symbol}`, 'UP'),
    })
    if (Result.isFailure(prices) || prices.success.bid <= 0n || prices.success.ask <= 0n) {
      return Result.fail(failure('prices', `quote for ${symbol} is outside the exact price domain`))
    }
    bidPriceMicros[symbol] = quantizeInstrumentPriceMicros(symbol, prices.success.bid, 'DOWN').toString()
    askPriceMicros[symbol] = quantizeInstrumentPriceMicros(symbol, prices.success.ask, 'UP').toString()
  }
  return Result.succeed({
    bidPriceMicros: Object.freeze(bidPriceMicros),
    askPriceMicros: Object.freeze(askPriceMicros),
  })
}

export const adverseClosingQuotePrices = (
  snapshot: StrategyMarketSnapshot,
  symbols: readonly string[],
): Result.Result<AdverseQuotePrices, IntradayMarketDataFailure> => {
  const maximumQuoteAge = millisecondsAsNanos(snapshot.manifest.maximumQuoteAgeMs)
  for (const symbol of [...new Set(symbols)].sort()) {
    const quote = snapshot.latestQuotes[symbol]
    if (quote === undefined) {
      return Result.fail(
        new IntradayMarketDataFailure({
          operation: 'close-quote-not-ready',
          message: `intraday snapshot has no verified quote for ${symbol}`,
          symbol,
        }),
      )
    }
    const quoteAge = intradayAgeNanos(snapshot.manifest.observedAt, quote.eventAt)
    if (quoteAge < 0n || quoteAge > maximumQuoteAge) {
      return Result.fail(
        new IntradayMarketDataFailure({
          operation: 'close-quote-not-ready',
          message: `closing quote for ${symbol} is outside the freshness window`,
          symbol,
          eventAt: quote.eventAt,
        }),
      )
    }
  }
  return adverseQuotePrices(snapshot, symbols)
}
