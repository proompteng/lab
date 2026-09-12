import { Result } from 'effect'

import {
  compareIntradayInstants,
  intradayAgeNanos,
  intradayInstantNanos,
  millisecondsAsNanos,
} from '../../market-data/intraday/time'
import {
  intradayMomentumSignalRejectionReasons,
  IntradayMomentumFailure,
  type IntradayMomentumCandidateExclusion,
  selectCanonicalIntradayMomentumSignals,
  type IntradayMomentumTargetPortfolio,
  type IntradayMomentumSignal,
} from './model'
import type { IntradayMomentumProtocol } from './protocol'

const micros = 1_000_000
const weightScale = 1_000_000

export interface IntradayMomentumCoreBar {
  readonly symbol: string
  readonly eventAt: string
  readonly open: number
  readonly high: number
  readonly low: number
}

export interface IntradayMomentumCoreQuote {
  readonly symbol: string
  readonly eventAt: string
  readonly bidPrice: number
  readonly bidSize: number
  readonly askPrice: number
  readonly askSize: number
}

export interface IntradayMomentumCoreTrade {
  readonly symbol: string
  readonly eventAt: string
  readonly price: number
}

export interface IntradayMomentumRollingPrices {
  readonly referencePriceMicros: string
  readonly rangeHighPriceMicros: string
  readonly rangeLowPriceMicros: string
}

export interface IntradayMomentumCoreInput {
  readonly rollingPrices?: Readonly<Record<string, IntradayMomentumRollingPrices>>
  readonly bars: readonly IntradayMomentumCoreBar[]
  readonly latestQuotes: Readonly<Record<string, IntradayMomentumCoreQuote>>
  readonly latestTrades: Readonly<Record<string, IntradayMomentumCoreTrade>>
  readonly observedAt: string
  /** Optional rolling-window anchor used to classify candidate-local incomplete bars. */
  readonly rangeStartAt?: string
  /** Exclusions already established by the immutable market-data query. */
  readonly candidateExclusions?: readonly IntradayMomentumCandidateExclusion[]
  readonly protocol: IntradayMomentumProtocol
}

export type IntradayMomentumCoreOutput = Pick<
  IntradayMomentumTargetPortfolio,
  'benchmark' | 'signals' | 'selectedSymbols' | 'targetWeights'
> & {
  readonly excludedCandidates: readonly IntradayMomentumCandidateExclusion[]
}

const fail = (
  reason: IntradayMomentumFailure['reason'],
  message: string,
  details: Pick<IntradayMomentumFailure, 'symbol' | 'field' | 'observed'> = {},
): Result.Result<never, IntradayMomentumFailure> =>
  Result.fail(new IntradayMomentumFailure({ reason, message, ...details }))

const finite = (
  value: number,
  field: string,
  symbol: string,
  positive: boolean,
): Result.Result<number, IntradayMomentumFailure> =>
  Number.isFinite(value) && (positive ? value > 0 : value >= 0)
    ? Result.succeed(value)
    : fail('market-value', 'intraday-momentum market value is outside its finite domain', {
        symbol,
        field,
        observed: value,
      })

const scaledInteger = (
  value: number,
  field: string,
  symbol: string,
  positive = true,
): Result.Result<bigint, IntradayMomentumFailure> =>
  Result.flatMap(finite(value, field, symbol, positive), (valid) => {
    const integer = Math.round(valid * micros)
    if (!Number.isSafeInteger(integer) || (positive && integer <= 0)) {
      return fail('market-value', 'intraday-momentum scaled value exceeds the exact integer domain', {
        symbol,
        field,
        observed: value,
      })
    }
    return Result.succeed(BigInt(integer))
  })

const floorDivide = (numerator: bigint, denominator: bigint): bigint => {
  const quotient = numerator / denominator
  return numerator < 0n && numerator % denominator !== 0n ? quotient - 1n : quotient
}

const ceilDivide = (numerator: bigint, denominator: bigint): bigint => {
  const quotient = numerator / denominator
  return numerator > 0n && numerator % denominator !== 0n ? quotient + 1n : quotient
}

const safeInteger = (value: bigint, field: string, symbol: string): Result.Result<number, IntradayMomentumFailure> =>
  value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)
    ? fail('market-value', 'intraday-momentum signal exceeds the exact integer domain', {
        symbol,
        field,
        observed: String(value),
      })
    : Result.succeed(Number(value))

const completeRollingBars = (
  bars: readonly IntradayMomentumCoreBar[],
  rangeStartAt: string | undefined,
  lookbackMinutes: number,
): boolean => {
  const ordered = bars.toSorted((left, right) => compareIntradayInstants(left.eventAt, right.eventAt))
  if (ordered.length === 0) return false
  if (rangeStartAt === undefined) return true
  const first = ordered[0]
  const last = ordered.at(-1)
  const rangeStartNanos = intradayInstantNanos(rangeStartAt)
  return (
    first !== undefined &&
    last !== undefined &&
    intradayInstantNanos(first.eventAt) === rangeStartNanos &&
    intradayInstantNanos(last.eventAt) === rangeStartNanos + BigInt(lookbackMinutes - 1) * 60_000_000_000n
  )
}

const candidateEvidenceIsStale = (
  quote: IntradayMomentumCoreQuote,
  trade: IntradayMomentumCoreTrade,
  observedAt: string,
  maximumQuoteAgeMs: number,
): boolean => {
  const maximumAge = millisecondsAsNanos(maximumQuoteAgeMs)
  return [quote.eventAt, trade.eventAt].some((eventAt) => {
    const age = intradayAgeNanos(observedAt, eventAt)
    return age < 0n || age > maximumAge
  })
}

const candidateExclusionsBySymbol = (
  exclusions: readonly IntradayMomentumCandidateExclusion[],
  protocol: IntradayMomentumProtocol,
): Result.Result<ReadonlyMap<string, IntradayMomentumCandidateExclusion>, IntradayMomentumFailure> => {
  const candidates = new Set(protocol.candidateSymbols)
  const bySymbol = new Map<string, IntradayMomentumCandidateExclusion>()
  for (const exclusion of exclusions) {
    if (
      !candidates.has(exclusion.symbol) ||
      exclusion.symbol === protocol.benchmarkSymbol ||
      (exclusion.reason !== 'not-ready' && exclusion.reason !== 'freshness') ||
      exclusion.message.trim().length === 0 ||
      bySymbol.has(exclusion.symbol)
    ) {
      return fail('snapshot-identity', 'intraday candidate exclusions do not bind the configured candidate universe', {
        symbol: exclusion.symbol,
      })
    }
    bySymbol.set(exclusion.symbol, exclusion)
  }
  return Result.succeed(bySymbol)
}

export interface IntradayMomentumSignalPrices {
  readonly reference: bigint
  readonly high: bigint
  readonly low: bigint
  readonly bid: bigint
  readonly ask: bigint
  readonly trade: bigint
}

export type IntradayMomentumBenchmarkPrices = Pick<IntradayMomentumSignalPrices, 'reference' | 'bid' | 'ask'>

export interface IntradayMomentumExactRatio {
  readonly numerator: bigint
  readonly denominator: bigint
}

export const deriveIntradayMomentumSignalMetrics = (
  prices: IntradayMomentumSignalPrices,
  symbol: string,
  benchmarkPrices: IntradayMomentumBenchmarkPrices,
): Result.Result<
  {
    readonly metrics: {
      readonly lookbackReturnBps: number
      readonly benchmarkReturnBps: number
      readonly excessReturnBps: number
      readonly breakoutBps: number
      readonly spreadBps: number
      readonly rangeLocationPpm: number
    }
    readonly excessReturn: IntradayMomentumExactRatio
  },
  IntradayMomentumFailure
> => {
  const doubledMidpoint = prices.bid + prices.ask
  const doubledReference = 2n * prices.reference
  const doubledBenchmarkMidpoint = benchmarkPrices.bid + benchmarkPrices.ask
  const doubledBenchmarkReference = 2n * benchmarkPrices.reference
  const breakoutReference = prices.ask < prices.trade ? prices.ask : prices.trade
  const lookbackReturnBps = floorDivide((doubledMidpoint - doubledReference) * 10_000n, doubledReference)
  const benchmarkReturnBps = floorDivide(
    (doubledBenchmarkMidpoint - doubledBenchmarkReference) * 10_000n,
    doubledBenchmarkReference,
  )
  // Preserve the exact candidate and benchmark ratios until after subtraction. Subtracting two independently
  // rounded basis-point values can admit a residual that is below the configured threshold.
  const excessReturn = Object.freeze({
    numerator:
      (doubledMidpoint - doubledReference) * benchmarkPrices.reference -
      (doubledBenchmarkMidpoint - doubledBenchmarkReference) * prices.reference,
    denominator: 2n * prices.reference * benchmarkPrices.reference,
  })
  const excessReturnBps = floorDivide(excessReturn.numerator * 10_000n, excessReturn.denominator)
  const breakoutBps = floorDivide((breakoutReference - prices.high) * 10_000n, prices.high)
  const spreadBps = ceilDivide((prices.ask - prices.bid) * 20_000n, doubledMidpoint)
  const rangeLocation =
    prices.high === prices.low
      ? 0n
      : floorDivide((doubledMidpoint - 2n * prices.low) * 1_000_000n, 2n * (prices.high - prices.low))
  const boundedRangeLocation = rangeLocation < 0n ? 0n : rangeLocation > 1_000_000n ? 1_000_000n : rangeLocation
  return Result.map(
    Result.all({
      lookbackReturnBps: safeInteger(lookbackReturnBps, 'lookback-return-bps', symbol),
      benchmarkReturnBps: safeInteger(benchmarkReturnBps, 'benchmark-return-bps', symbol),
      excessReturnBps: safeInteger(excessReturnBps, 'excess-return-bps', symbol),
      breakoutBps: safeInteger(breakoutBps, 'breakout-bps', symbol),
      spreadBps: safeInteger(spreadBps, 'spread-bps', symbol),
      rangeLocationPpm: safeInteger(boundedRangeLocation, 'range-location-ppm', symbol),
    }),
    (metrics) => ({ metrics, excessReturn }),
  )
}

const preparedRollingPrices = (
  values: IntradayMomentumRollingPrices,
  symbol: string,
): Result.Result<
  { readonly reference: bigint; readonly high: bigint; readonly low: bigint },
  IntradayMomentumFailure
> => {
  const strings = [values.referencePriceMicros, values.rangeHighPriceMicros, values.rangeLowPriceMicros]
  if (strings.some((value) => !/^[1-9][0-9]*$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)))
    return fail('market-value', 'rolling feature prices exceed the exact positive integer domain', { symbol })
  const reference = BigInt(values.referencePriceMicros)
  const high = BigInt(values.rangeHighPriceMicros)
  const low = BigInt(values.rangeLowPriceMicros)
  return low <= reference && reference <= high
    ? Result.succeed({ reference, high, low })
    : fail('market-value', 'rolling feature range is inconsistent', { symbol })
}

const signalFor = (
  symbol: string,
  bars: readonly IntradayMomentumCoreBar[],
  quote: IntradayMomentumCoreQuote,
  trade: IntradayMomentumCoreTrade,
  protocol: IntradayMomentumProtocol,
  observedAt: string,
  benchmarkPrices: IntradayMomentumBenchmarkPrices,
  rolling?: IntradayMomentumRollingPrices,
): Result.Result<IntradayMomentumSignal, IntradayMomentumFailure> => {
  const ordered = bars.toSorted((left, right) => compareIntradayInstants(left.eventAt, right.eventAt))
  const first = ordered[0]
  if (first === undefined) return fail('snapshot-coverage', 'intraday symbol has no rolling bars', { symbol })
  return Result.gen(function* () {
    const range =
      rolling === undefined
        ? yield* Result.gen(function* () {
            const reference = yield* finite(first.open, 'lookback-open', symbol, true)
            const highs = yield* Result.all(ordered.map((bar) => finite(bar.high, 'bar-high', symbol, true)))
            const lows = yield* Result.all(ordered.map((bar) => finite(bar.low, 'bar-low', symbol, true)))
            return yield* Result.all({
              reference: scaledInteger(reference, 'lookback-open', symbol),
              high: scaledInteger(Math.max(...highs), 'range-high', symbol),
              low: scaledInteger(Math.min(...lows), 'range-low', symbol),
            })
          })
        : yield* preparedRollingPrices(rolling, symbol)
    const bid = yield* finite(quote.bidPrice, 'quote-bid', symbol, true)
    const ask = yield* finite(quote.askPrice, 'quote-ask', symbol, true)
    const tradePrice = yield* finite(trade.price, 'trade-price', symbol, true)
    if (ask < bid) return yield* fail('market-value', 'intraday quote is crossed', { symbol })
    const prices = yield* Result.all({
      reference: Result.succeed(range.reference),
      high: Result.succeed(range.high),
      low: Result.succeed(range.low),
      bid: scaledInteger(bid, 'quote-bid', symbol),
      ask: scaledInteger(ask, 'quote-ask', symbol),
      trade: scaledInteger(tradePrice, 'trade-price', symbol),
      bidSize: scaledInteger(quote.bidSize, 'quote-bid-size', symbol, false),
      askSize: scaledInteger(quote.askSize, 'quote-ask-size', symbol, false),
    })
    const { metrics, excessReturn } = yield* deriveIntradayMomentumSignalMetrics(prices, symbol, benchmarkPrices)
    const evidence = {
      symbol,
      referencePriceMicros: String(prices.reference),
      rangeHighPriceMicros: String(prices.high),
      rangeLowPriceMicros: String(prices.low),
      bidPriceMicros: String(prices.bid),
      askPriceMicros: String(prices.ask),
      bidSizeMicros: String(prices.bidSize),
      askSizeMicros: String(prices.askSize),
      quoteObservedAt: quote.eventAt,
      confirmationTradePriceMicros: String(prices.trade),
      confirmationTradeObservedAt: trade.eventAt,
      excessReturnNumerator: String(excessReturn.numerator),
      excessReturnDenominator: String(excessReturn.denominator),
      ...metrics,
    }
    const rejectionReasons = intradayMomentumSignalRejectionReasons(evidence, observedAt, protocol)
    return Object.freeze({
      ...evidence,
      eligible: rejectionReasons.length === 0,
      rejectionReasons,
      rank: null,
    })
  })
}

/** Pure event/math boundary shared by verified archive and vendor historical evaluation. */
export const decideIntradayMomentumCore = (
  input: IntradayMomentumCoreInput,
): Result.Result<IntradayMomentumCoreOutput, IntradayMomentumFailure> =>
  Result.gen(function* () {
    const { protocol } = input
    const benchmarkBars = input.bars.filter(({ symbol }) => symbol === protocol.benchmarkSymbol)
    const benchmarkQuote = input.latestQuotes[protocol.benchmarkSymbol]
    const benchmarkFirst = benchmarkBars.toSorted((left, right) =>
      compareIntradayInstants(left.eventAt, right.eventAt),
    )[0]
    if (
      benchmarkFirst === undefined ||
      benchmarkQuote === undefined ||
      !completeRollingBars(benchmarkBars, input.rangeStartAt, protocol.lookbackMinutes)
    ) {
      return yield* fail('snapshot-coverage', 'intraday decision lacks benchmark bars or quote', {
        symbol: protocol.benchmarkSymbol,
      })
    }
    if (
      intradayAgeNanos(input.observedAt, benchmarkQuote.eventAt) < 0n ||
      intradayAgeNanos(input.observedAt, benchmarkQuote.eventAt) > millisecondsAsNanos(protocol.maximumQuoteAgeMs)
    ) {
      return yield* fail('snapshot-coverage', 'intraday benchmark quote exceeds the protocol freshness bound', {
        symbol: protocol.benchmarkSymbol,
      })
    }
    if (benchmarkQuote.bidSize <= 0 || benchmarkQuote.askSize <= 0) {
      return yield* fail('snapshot-coverage', 'intraday benchmark quote has no executable displayed liquidity', {
        symbol: protocol.benchmarkSymbol,
      })
    }
    const benchmarkPrices = yield* Result.gen(function* () {
      const rolling = input.rollingPrices?.[protocol.benchmarkSymbol]
      if (input.rollingPrices !== undefined && rolling === undefined)
        return yield* fail('snapshot-coverage', 'required benchmark rolling feature is unavailable', {
          symbol: protocol.benchmarkSymbol,
        })
      const reference =
        rolling === undefined
          ? yield* scaledInteger(benchmarkFirst.open, 'benchmark-lookback-open', protocol.benchmarkSymbol)
          : (yield* preparedRollingPrices(rolling, protocol.benchmarkSymbol)).reference
      const bid = yield* scaledInteger(benchmarkQuote.bidPrice, 'benchmark-quote-bid', protocol.benchmarkSymbol)
      const ask = yield* scaledInteger(benchmarkQuote.askPrice, 'benchmark-quote-ask', protocol.benchmarkSymbol)
      const bidSize = yield* scaledInteger(benchmarkQuote.bidSize, 'benchmark-quote-bid-size', protocol.benchmarkSymbol)
      const askSize = yield* scaledInteger(benchmarkQuote.askSize, 'benchmark-quote-ask-size', protocol.benchmarkSymbol)
      if (ask < bid) {
        return yield* fail('market-value', 'intraday benchmark quote is crossed', {
          symbol: protocol.benchmarkSymbol,
        })
      }
      return { reference, bid, ask, bidSize, askSize }
    })
    const explicitExclusions = yield* candidateExclusionsBySymbol(input.candidateExclusions ?? [], protocol)
    const candidates: IntradayMomentumSignal[] = []
    const excludedCandidates: IntradayMomentumCandidateExclusion[] = []
    for (const symbol of protocol.candidateSymbols) {
      const explicitExclusion = explicitExclusions.get(symbol)
      if (explicitExclusion !== undefined) {
        excludedCandidates.push(explicitExclusion)
        continue
      }
      const bars = input.bars.filter((bar) => bar.symbol === symbol)
      const quote = input.latestQuotes[symbol]
      const trade = input.latestTrades[symbol]
      if (!completeRollingBars(bars, input.rangeStartAt, protocol.lookbackMinutes)) {
        excludedCandidates.push({
          symbol,
          reason: 'not-ready',
          message: 'intraday candidate lacks a complete rolling bar window',
        })
        continue
      }
      if (quote === undefined || trade === undefined) {
        excludedCandidates.push({
          symbol,
          reason: 'not-ready',
          message: 'intraday candidate lacks quote or trade confirmation',
        })
        continue
      }
      if (candidateEvidenceIsStale(quote, trade, input.observedAt, protocol.maximumQuoteAgeMs)) {
        excludedCandidates.push({
          symbol,
          reason: 'freshness',
          message: 'intraday candidate quote or trade exceeds the protocol freshness bound',
        })
        continue
      }
      const rolling = input.rollingPrices?.[symbol]
      if (input.rollingPrices !== undefined && rolling === undefined) {
        excludedCandidates.push({
          symbol,
          reason: 'not-ready',
          message: 'required candidate rolling feature is unavailable',
        })
        continue
      }
      candidates.push(
        yield* signalFor(symbol, bars, quote, trade, protocol, input.observedAt, benchmarkPrices, rolling),
      )
    }
    const selected = selectCanonicalIntradayMomentumSignals(candidates, protocol.maximumPositions)
    const selectedSymbols = Object.freeze(selected.map(({ symbol }) => symbol))
    const rankBySymbol = new Map(selectedSymbols.map((symbol, index) => [symbol, index + 1]))
    const rankedSignals = Object.freeze(
      candidates.map((signal) => Object.freeze({ ...signal, rank: rankBySymbol.get(signal.symbol) ?? null })),
    )
    const targetWeight =
      selectedSymbols.length === 0
        ? 0
        : Math.min(
            Math.floor(protocol.maximumSymbolWeight * weightScale),
            Math.floor((protocol.maximumGrossWeight * weightScale) / selectedSymbols.length),
          ) / weightScale
    const selectedSet = new Set(selectedSymbols)
    return Object.freeze({
      benchmark: Object.freeze({
        symbol: protocol.benchmarkSymbol,
        referencePriceMicros: String(benchmarkPrices.reference),
        bidPriceMicros: String(benchmarkPrices.bid),
        askPriceMicros: String(benchmarkPrices.ask),
        bidSizeMicros: String(benchmarkPrices.bidSize),
        askSizeMicros: String(benchmarkPrices.askSize),
        quoteObservedAt: benchmarkQuote.eventAt,
      }),
      selectedSymbols,
      excludedCandidates: Object.freeze(excludedCandidates),
      targetWeights: Object.freeze(
        Object.fromEntries(
          protocol.candidateSymbols.map((symbol) => [symbol, selectedSet.has(symbol) ? targetWeight : 0]),
        ),
      ),
      signals: rankedSignals,
    })
  })
