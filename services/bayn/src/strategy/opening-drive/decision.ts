import { Result, Schema } from 'effect'

import { makeExecutionCalendarObservation } from '../../cycle'
import { sha256 } from '../../hash'
import {
  compareIntradayInstants,
  intradayAgeNanos,
  intradayInstantNanos,
  millisecondsAsNanos,
  reverifyIntradayMarketSnapshot,
  type IntradayBar,
  type IntradayQuote,
  type IntradayTrade,
} from '../../market-data'
import { strictParseOptions, UtcInstantSchema } from '../../schemas'
import type { VerifiedStrategyContext } from '../core'
import {
  OpeningDriveFailure,
  type OpeningDriveMarketContext,
  type OpeningDriveRejectionReason,
  type OpeningDriveSignal,
  type OpeningDriveStrategyDefinition,
  type OpeningDriveTargetPortfolio,
} from './model'
import type { OpeningDriveProtocol } from './protocol'

const micros = 1_000_000
const weightScale = 1_000_000

export const openingDriveBehaviorVersion = 'bayn.opening-drive-momentum.behavior.v2' as const
export const openingDriveBehaviorHash = sha256(openingDriveBehaviorVersion)

const compareCanonicalText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareLatestTrade = (left: IntradayTrade, right: IntradayTrade): number => {
  const eventOrder = compareIntradayInstants(right.eventAt, left.eventAt)
  if (eventOrder !== 0) return eventOrder
  const topicOrder = compareCanonicalText(right.sourceTopic, left.sourceTopic)
  if (topicOrder !== 0) return topicOrder
  const partitionOrder = right.sourcePartition - left.sourcePartition
  if (partitionOrder !== 0) return partitionOrder
  const leftOffset = BigInt(left.sourceOffset)
  const rightOffset = BigInt(right.sourceOffset)
  return rightOffset > leftOffset ? 1 : rightOffset < leftOffset ? -1 : 0
}

const compareLatestQuote = (left: IntradayQuote, right: IntradayQuote): number => {
  const eventOrder = compareIntradayInstants(right.eventAt, left.eventAt)
  if (eventOrder !== 0) return eventOrder
  const topicOrder = compareCanonicalText(right.sourceTopic, left.sourceTopic)
  if (topicOrder !== 0) return topicOrder
  const partitionOrder = right.sourcePartition - left.sourcePartition
  if (partitionOrder !== 0) return partitionOrder
  const leftOffset = BigInt(left.sourceOffset)
  const rightOffset = BigInt(right.sourceOffset)
  return rightOffset > leftOffset ? 1 : rightOffset < leftOffset ? -1 : 0
}

const fail = (
  reason: OpeningDriveFailure['reason'],
  message: string,
  details: Pick<OpeningDriveFailure, 'symbol' | 'field' | 'observed'> = {},
): Result.Result<never, OpeningDriveFailure> => Result.fail(new OpeningDriveFailure({ reason, message, ...details }))

const finite = (
  value: number,
  field: string,
  symbol: string,
  positive: boolean,
): Result.Result<number, OpeningDriveFailure> =>
  Number.isFinite(value) && (positive ? value > 0 : value >= 0)
    ? Result.succeed(value)
    : fail('market-value', 'opening-drive market value is outside its finite domain', {
        symbol,
        field,
        observed: value,
      })

const scaledInteger = (
  value: number,
  field: string,
  symbol: string,
  rounding: 'floor' | 'round',
  positive = true,
): Result.Result<bigint, OpeningDriveFailure> =>
  Result.flatMap(finite(value, field, symbol, positive), (valid) => {
    const scaled = valid * micros
    const integer = rounding === 'floor' ? Math.floor(scaled) : Math.round(scaled)
    if (!Number.isSafeInteger(integer) || (positive && integer <= 0)) {
      return fail('market-value', 'opening-drive scaled market value exceeds the exact integer domain', {
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

const safeInteger = (value: bigint, field: string, symbol: string): Result.Result<number, OpeningDriveFailure> => {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return fail('market-value', 'opening-drive derived signal exceeds the exact integer domain', {
      symbol,
      field,
      observed: String(value),
    })
  }
  return Result.succeed(Number(value))
}

interface SignalPrices {
  readonly opening: bigint
  readonly high: bigint
  readonly low: bigint
  readonly bid: bigint
  readonly ask: bigint
  readonly trade: bigint
}

const deriveSignalMetrics = (
  prices: SignalPrices,
  symbol: string,
): Result.Result<
  {
    readonly openingReturnBps: number
    readonly breakoutBps: number
    readonly spreadBps: number
    readonly rangeLocationPpm: number
  },
  OpeningDriveFailure
> => {
  const doubledMidpoint = prices.bid + prices.ask
  const doubledOpening = 2n * prices.opening
  const breakoutReference = prices.ask < prices.trade ? prices.ask : prices.trade
  const openingReturnBps = floorDivide((doubledMidpoint - doubledOpening) * 10_000n, doubledOpening)
  const breakoutBps = floorDivide((breakoutReference - prices.high) * 10_000n, prices.high)
  const spreadBps = ceilDivide((prices.ask - prices.bid) * 20_000n, doubledMidpoint)
  const rangeLocationPpm =
    prices.high === prices.low
      ? 0n
      : floorDivide((doubledMidpoint - 2n * prices.low) * 1_000_000n, 2n * (prices.high - prices.low))
  const boundedRangeLocationPpm =
    rangeLocationPpm < 0n ? 0n : rangeLocationPpm > 1_000_000n ? 1_000_000n : rangeLocationPpm
  return Result.all({
    openingReturnBps: safeInteger(openingReturnBps, 'opening-return-bps', symbol),
    breakoutBps: safeInteger(breakoutBps, 'breakout-bps', symbol),
    spreadBps: safeInteger(spreadBps, 'spread-bps', symbol),
    rangeLocationPpm: safeInteger(boundedRangeLocationPpm, 'range-location-ppm', symbol),
  })
}

const validateSnapshot = (
  context: OpeningDriveMarketContext,
  protocol: OpeningDriveProtocol,
): Result.Result<void, OpeningDriveFailure> => {
  const { session, snapshot } = context
  const manifest = snapshot.manifest
  const boundSession = manifest.calendar.sessions.find(({ date }) => date === manifest.sessionDate)
  const selectedCalendar =
    boundSession === undefined
      ? undefined
      : makeExecutionCalendarObservation({
          schemaVersion: manifest.calendar.schemaVersion,
          source: manifest.calendar.source,
          ...boundSession,
        })
  if (
    manifest.universeId !== protocol.universeId ||
    manifest.universeSymbolHash !== protocol.universeSymbolHash ||
    manifest.feed !== protocol.feed ||
    manifest.delayClass !== protocol.delayClass ||
    manifest.symbols.length !== protocol.universe.length ||
    manifest.symbols.some((symbol, index) => symbol !== protocol.universe[index])
  ) {
    return fail('snapshot-identity', 'intraday snapshot does not match the opening-drive protocol')
  }
  const rangeStart = Date.parse(manifest.rangeStartAt)
  const rangeEnd = Date.parse(manifest.rangeEndAt)
  const observed = Date.parse(manifest.observedAt)
  const rangeEndNanos = intradayInstantNanos(manifest.rangeEndAt)
  const observedNanos = intradayInstantNanos(manifest.observedAt)
  const sessionOpen = Date.parse(session.openAt)
  const sessionClose = Date.parse(session.closeAt)
  const canonicalSessionInstants = Result.all([
    Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)(session.openAt),
    Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)(session.closeAt),
  ])
  const entryCutoff = sessionOpen + protocol.entryCutoffMinutesAfterOpen * 60_000
  const flattenAt = sessionClose - protocol.flattenBeforeCloseMinutes * 60_000
  const earliestDecision = rangeEnd + protocol.decisionDelaySeconds * 1_000
  const decisionWindowEnd = Math.min(entryCutoff, flattenAt)
  if (
    Result.isFailure(canonicalSessionInstants) ||
    !Number.isFinite(rangeStart) ||
    !Number.isFinite(rangeEnd) ||
    !Number.isFinite(observed) ||
    !Number.isFinite(sessionOpen) ||
    !Number.isFinite(sessionClose) ||
    !Number.isSafeInteger(entryCutoff) ||
    !Number.isSafeInteger(flattenAt) ||
    !Number.isSafeInteger(earliestDecision) ||
    !Number.isSafeInteger(decisionWindowEnd) ||
    session.sessionDate !== manifest.sessionDate ||
    boundSession === undefined ||
    session.openAt !== manifest.rangeStartAt ||
    session.openAt !== boundSession.openAt ||
    session.closeAt !== boundSession.closeAt ||
    selectedCalendar === undefined ||
    Result.isFailure(selectedCalendar) ||
    session.calendarHash !== selectedCalendar.success.executionCalendarHash ||
    sessionOpen >= sessionClose ||
    rangeEnd > sessionClose ||
    observed > sessionClose ||
    earliestDecision >= decisionWindowEnd ||
    observed >= decisionWindowEnd ||
    !/^[0-9a-f]{64}$/.test(session.calendarHash) ||
    rangeEnd - rangeStart !== protocol.openingRangeMinutes * 60_000 ||
    observed < earliestDecision
  ) {
    return fail('snapshot-window', 'intraday snapshot does not bind the frozen opening-drive decision window')
  }
  if (
    manifest.barCount !== snapshot.bars.length ||
    manifest.quoteCount !== snapshot.quotes.length ||
    manifest.tradeCount !== snapshot.trades.length ||
    snapshot.bars.length !== protocol.universe.length * protocol.openingRangeMinutes
  ) {
    return fail('snapshot-coverage', 'intraday snapshot counts do not cover the opening-drive universe')
  }
  if (snapshot.bars.some((bar) => !bar.final)) {
    return fail('snapshot-coverage', 'opening-drive decision requires only final opening bars')
  }
  for (const symbol of protocol.universe) {
    const symbolQuotes = snapshot.quotes.filter((candidate) => candidate.symbol === symbol).toSorted(compareLatestQuote)
    const quote = symbolQuotes[0]
    if (
      quote !== undefined &&
      symbolQuotes.some(
        (candidate) =>
          candidate !== quote &&
          compareIntradayInstants(candidate.eventAt, quote.eventAt) === 0 &&
          (candidate.sourceTopic !== quote.sourceTopic || candidate.sourcePartition !== quote.sourcePartition),
      )
    ) {
      return fail('snapshot-coverage', 'opening-drive latest quote is ambiguous across Kafka partitions', { symbol })
    }
    if (
      quote === undefined ||
      quote.symbol !== symbol ||
      intradayInstantNanos(quote.eventAt) < rangeEndNanos ||
      intradayInstantNanos(quote.eventAt) > observedNanos
    ) {
      return fail('snapshot-coverage', 'opening-drive decision lacks a post-range quote', { symbol })
    }
    const symbolTrades = snapshot.trades.filter((trade) => trade.symbol === symbol).toSorted(compareLatestTrade)
    const latestTrade = symbolTrades[0]
    if (
      latestTrade !== undefined &&
      symbolTrades.some(
        (trade) =>
          trade !== latestTrade &&
          compareIntradayInstants(trade.eventAt, latestTrade.eventAt) === 0 &&
          (trade.sourceTopic !== latestTrade.sourceTopic || trade.sourcePartition !== latestTrade.sourcePartition),
      )
    ) {
      return fail('snapshot-coverage', 'opening-drive latest trade is ambiguous across Kafka partitions', { symbol })
    }
    if (
      latestTrade === undefined ||
      intradayInstantNanos(latestTrade.eventAt) < rangeEndNanos ||
      intradayInstantNanos(latestTrade.eventAt) > observedNanos
    ) {
      return fail('snapshot-coverage', 'opening-drive decision lacks a post-range trade', { symbol })
    }
  }
  return Result.succeed(undefined)
}

const openingDollarVolume = (
  symbol: string,
  bars: readonly IntradayBar[],
): Result.Result<bigint, OpeningDriveFailure> =>
  Result.map(
    Result.all(
      bars.map((bar) =>
        Result.gen(function* () {
          const referenceField = bar.vwap === null ? 'bar-close' : 'bar-vwap'
          const referencePrice = yield* finite(bar.vwap ?? bar.close, referenceField, symbol, true)
          const low = yield* finite(bar.low, 'bar-low', symbol, true)
          const high = yield* finite(bar.high, 'bar-high', symbol, true)
          if (high < low || referencePrice < low || referencePrice > high) {
            return yield* fail('market-value', 'opening-drive bar reference price is outside its traded range', {
              symbol,
              field: referenceField,
              observed: referencePrice,
            })
          }
          return {
            price: yield* scaledInteger(referencePrice, referenceField, symbol, 'round'),
            volume: yield* scaledInteger(bar.volume, 'bar-volume', symbol, 'floor', false),
          }
        }),
      ),
    ),
    (values) => values.reduce((total, value) => total + (value.price * value.volume) / BigInt(micros), 0n),
  )

const signalFor = (
  symbol: string,
  bars: readonly IntradayBar[],
  quote: IntradayQuote,
  trade: IntradayTrade,
  protocol: OpeningDriveProtocol,
  observedAt: string,
): Result.Result<OpeningDriveSignal, OpeningDriveFailure> => {
  const orderedBars = bars.toSorted((left, right) => left.eventAt.localeCompare(right.eventAt))
  const first = orderedBars[0]
  if (first === undefined || orderedBars.length !== protocol.openingRangeMinutes) {
    return fail('snapshot-coverage', 'opening-drive symbol does not have one complete opening bar range', {
      symbol,
      observed: orderedBars.length,
    })
  }
  return Result.gen(function* () {
    const open = yield* finite(first.open, 'opening-price', symbol, true)
    const highs = yield* Result.all(orderedBars.map((bar) => finite(bar.high, 'bar-high', symbol, true)))
    const lows = yield* Result.all(orderedBars.map((bar) => finite(bar.low, 'bar-low', symbol, true)))
    const bid = yield* finite(quote.bidPrice, 'quote-bid', symbol, true)
    const ask = yield* finite(quote.askPrice, 'quote-ask', symbol, true)
    const bidSize = yield* finite(quote.bidSize, 'quote-bid-size', symbol, false)
    const askSize = yield* finite(quote.askSize, 'quote-ask-size', symbol, false)
    const tradePrice = yield* finite(trade.price, 'trade-price', symbol, true)
    if (ask < bid) return yield* fail('market-value', 'opening-drive quote is crossed', { symbol })
    const high = Math.max(...highs)
    const low = Math.min(...lows)
    const prices = yield* Result.all({
      opening: scaledInteger(open, 'opening-price', symbol, 'round'),
      high: scaledInteger(high, 'range-high', symbol, 'round'),
      low: scaledInteger(low, 'range-low', symbol, 'round'),
      bid: scaledInteger(bid, 'quote-bid', symbol, 'round'),
      ask: scaledInteger(ask, 'quote-ask', symbol, 'round'),
      trade: scaledInteger(tradePrice, 'trade-price', symbol, 'round'),
    })
    const { openingReturnBps, breakoutBps, spreadBps, rangeLocationPpm } = yield* deriveSignalMetrics(prices, symbol)
    const dollarVolume = yield* openingDollarVolume(symbol, orderedBars)
    const minimumDollarVolume = BigInt(protocol.minimumOpeningDollarVolumeMicros)
    const rejectionReasons: OpeningDriveRejectionReason[] = []
    if (openingReturnBps < protocol.minimumOpeningReturnBps) rejectionReasons.push('opening-return')
    if (breakoutBps < protocol.minimumBreakoutBps) rejectionReasons.push('breakout')
    if (rangeLocationPpm < protocol.minimumRangeLocationPpm) rejectionReasons.push('range-location')
    if (spreadBps > protocol.maximumSpreadBps) rejectionReasons.push('spread')
    if (dollarVolume < minimumDollarVolume) rejectionReasons.push('dollar-volume')
    if (bidSize === 0 || askSize === 0) rejectionReasons.push('displayed-liquidity')
    const maximumMarketDataAge = millisecondsAsNanos(protocol.maximumQuoteAgeMs)
    if (
      intradayAgeNanos(observedAt, quote.eventAt) > maximumMarketDataAge ||
      intradayAgeNanos(observedAt, trade.eventAt) > maximumMarketDataAge
    ) {
      rejectionReasons.push('market-data-freshness')
    }
    return Object.freeze({
      symbol,
      openingPriceMicros: String(prices.opening),
      rangeHighPriceMicros: String(prices.high),
      rangeLowPriceMicros: String(prices.low),
      bidPriceMicros: String(prices.bid),
      askPriceMicros: String(prices.ask),
      quoteObservedAt: quote.eventAt,
      breakoutTradePriceMicros: String(prices.trade),
      breakoutTradeObservedAt: trade.eventAt,
      openingReturnBps,
      breakoutBps,
      rangeLocationPpm,
      spreadBps,
      openingDollarVolumeMicros: String(dollarVolume),
      eligible: rejectionReasons.length === 0,
      rejectionReasons: Object.freeze(rejectionReasons),
      rank: null,
    })
  })
}

const compareEligible = (left: OpeningDriveSignal, right: OpeningDriveSignal): number =>
  right.openingReturnBps - left.openingReturnBps ||
  right.rangeLocationPpm - left.rangeLocationPpm ||
  (BigInt(right.openingDollarVolumeMicros) > BigInt(left.openingDollarVolumeMicros)
    ? 1
    : BigInt(right.openingDollarVolumeMicros) < BigInt(left.openingDollarVolumeMicros)
      ? -1
      : left.symbol.localeCompare(right.symbol))

export const decideOpeningDrive = (
  context: OpeningDriveMarketContext,
  protocol: OpeningDriveProtocol,
): Result.Result<OpeningDriveTargetPortfolio, OpeningDriveFailure> =>
  Result.gen(function* () {
    const { session } = context
    const snapshot = yield* Result.mapError(
      reverifyIntradayMarketSnapshot(context.snapshot),
      (cause) =>
        new OpeningDriveFailure({
          reason:
            cause.reason === 'identity'
              ? 'snapshot-identity'
              : cause.reason === 'request'
                ? 'snapshot-window'
                : 'snapshot-coverage',
          message: `opening-drive snapshot failed authoritative re-verification: ${cause.message}`,
          cause,
        }),
    )
    yield* validateSnapshot({ ...context, snapshot }, protocol)
    const signals = yield* Result.all(
      protocol.universe.map((symbol) => {
        const quote = snapshot.latestQuotes[symbol]
        const trade = snapshot.trades.filter((candidate) => candidate.symbol === symbol).toSorted(compareLatestTrade)[0]
        return quote === undefined || trade === undefined
          ? fail('snapshot-coverage', 'opening-drive decision lacks quote or trade confirmation', { symbol })
          : signalFor(
              symbol,
              snapshot.bars.filter((bar) => bar.symbol === symbol),
              quote,
              trade,
              protocol,
              snapshot.manifest.observedAt,
            )
      }),
    )
    const selected = signals
      .filter((signal) => signal.eligible)
      .toSorted(compareEligible)
      .slice(0, protocol.maximumPositions)
    const selectedSymbols = Object.freeze(selected.map((signal) => signal.symbol))
    const rankBySymbol = new Map(selectedSymbols.map((symbol, index) => [symbol, index + 1]))
    const rankedSignals = Object.freeze(
      signals.map((signal) => Object.freeze({ ...signal, rank: rankBySymbol.get(signal.symbol) ?? null })),
    )
    const targetWeight =
      selectedSymbols.length === 0
        ? 0
        : Math.min(
            Math.floor(protocol.maximumSymbolWeight * weightScale),
            Math.floor((protocol.maximumGrossWeight * weightScale) / selectedSymbols.length),
          ) / weightScale
    const selectedSet = new Set(selectedSymbols)
    const targetWeights = Object.freeze(
      Object.fromEntries(protocol.universe.map((symbol) => [symbol, selectedSet.has(symbol) ? targetWeight : 0])),
    )
    return Object.freeze({
      schemaVersion: 'bayn.opening-drive.target.v1',
      strategy: 'opening-drive-momentum',
      sessionDate: snapshot.manifest.sessionDate,
      snapshotId: snapshot.manifest.snapshotId,
      observedAt: snapshot.manifest.observedAt,
      calendarHash: session.calendarHash,
      selectedSymbols,
      targetWeights,
      signals: rankedSignals,
    })
  })

export const makeOpeningDriveDefinition = (protocol: OpeningDriveProtocol): OpeningDriveStrategyDefinition => ({
  name: 'opening-drive-momentum',
  holdingPeriod: 'INTRADAY',
  parameters: protocol,
  decide: (context: VerifiedStrategyContext<OpeningDriveMarketContext>) => decideOpeningDrive(context.market, protocol),
})
