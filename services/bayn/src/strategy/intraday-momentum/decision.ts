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
  IntradayMomentumFailure,
  type IntradayMomentumMarketContext,
  type IntradayMomentumRejectionReason,
  type IntradayMomentumSignal,
  type IntradayMomentumStrategyDefinition,
  type IntradayMomentumTargetPortfolio,
} from './model'
import { intradayMomentumSessionHasDecisionInterval, type IntradayMomentumProtocol } from './protocol'

const micros = 1_000_000
const weightScale = 1_000_000
const minuteMs = 60_000

export const intradayMomentumBehaviorVersion = 'bayn.intraday-momentum.behavior.v3' as const
export const intradayMomentumBehaviorHash = sha256(intradayMomentumBehaviorVersion)

const compareCanonicalText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareLatest = <T extends IntradayQuote | IntradayTrade>(left: T, right: T): number => {
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

interface SignalPrices {
  readonly reference: bigint
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
    readonly lookbackReturnBps: number
    readonly breakoutBps: number
    readonly spreadBps: number
    readonly rangeLocationPpm: number
  },
  IntradayMomentumFailure
> => {
  const doubledMidpoint = prices.bid + prices.ask
  const doubledReference = 2n * prices.reference
  const breakoutReference = prices.ask < prices.trade ? prices.ask : prices.trade
  const lookbackReturnBps = floorDivide((doubledMidpoint - doubledReference) * 10_000n, doubledReference)
  const breakoutBps = floorDivide((breakoutReference - prices.high) * 10_000n, prices.high)
  const spreadBps = ceilDivide((prices.ask - prices.bid) * 20_000n, doubledMidpoint)
  const rangeLocation =
    prices.high === prices.low
      ? 0n
      : floorDivide((doubledMidpoint - 2n * prices.low) * 1_000_000n, 2n * (prices.high - prices.low))
  const boundedRangeLocation = rangeLocation < 0n ? 0n : rangeLocation > 1_000_000n ? 1_000_000n : rangeLocation
  return Result.all({
    lookbackReturnBps: safeInteger(lookbackReturnBps, 'lookback-return-bps', symbol),
    breakoutBps: safeInteger(breakoutBps, 'breakout-bps', symbol),
    spreadBps: safeInteger(spreadBps, 'spread-bps', symbol),
    rangeLocationPpm: safeInteger(boundedRangeLocation, 'range-location-ppm', symbol),
  })
}

const validateSnapshot = (
  context: IntradayMomentumMarketContext,
  protocol: IntradayMomentumProtocol,
): Result.Result<void, IntradayMomentumFailure> => {
  const { session, snapshot } = context
  const { manifest } = snapshot
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
    manifest.maximumQuoteAgeMs !== protocol.maximumQuoteAgeMs ||
    manifest.symbols.length !== protocol.universe.length ||
    manifest.symbols.some((symbol, index) => symbol !== protocol.universe[index])
  ) {
    return fail('snapshot-identity', 'intraday snapshot does not match the intraday-momentum protocol')
  }

  const rangeStart = Date.parse(manifest.rangeStartAt)
  const rangeEnd = Date.parse(manifest.rangeEndAt)
  const observed = Date.parse(manifest.observedAt)
  const sessionOpen = Date.parse(session.openAt)
  const sessionClose = Date.parse(session.closeAt)
  const earliestRangeEnd = sessionOpen + protocol.warmupMinutesAfterOpen * minuteMs
  const entryCutoff = sessionClose - protocol.entryCutoffMinutesBeforeClose * minuteMs
  const earliestDecision = rangeEnd + protocol.decisionDelaySeconds * 1_000
  const latestDecision = earliestDecision + protocol.maximumDecisionLagMs
  const canonicalSessionInstants = Result.all([
    Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)(session.openAt),
    Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)(session.closeAt),
  ])
  if (
    Result.isFailure(canonicalSessionInstants) ||
    ![
      rangeStart,
      rangeEnd,
      observed,
      sessionOpen,
      sessionClose,
      earliestRangeEnd,
      entryCutoff,
      earliestDecision,
      latestDecision,
    ].every(Number.isSafeInteger) ||
    session.sessionDate !== manifest.sessionDate ||
    boundSession === undefined ||
    session.openAt !== boundSession.openAt ||
    session.closeAt !== boundSession.closeAt ||
    selectedCalendar === undefined ||
    Result.isFailure(selectedCalendar) ||
    session.calendarHash !== selectedCalendar.success.executionCalendarHash ||
    sessionOpen >= sessionClose ||
    !intradayMomentumSessionHasDecisionInterval(protocol, session) ||
    rangeStart < sessionOpen ||
    rangeEnd - rangeStart !== protocol.lookbackMinutes * minuteMs ||
    rangeEnd < earliestRangeEnd ||
    rangeEnd > entryCutoff ||
    observed < earliestDecision ||
    observed > latestDecision ||
    observed >= entryCutoff ||
    observed > sessionClose ||
    !/^[0-9a-f]{64}$/.test(session.calendarHash)
  ) {
    return fail('snapshot-window', 'intraday snapshot does not bind an eligible rolling decision window')
  }
  if (
    manifest.barCount !== snapshot.bars.length ||
    manifest.quoteCount !== snapshot.quotes.length ||
    manifest.tradeCount !== snapshot.trades.length ||
    snapshot.bars.length > protocol.universe.length * protocol.lookbackMinutes ||
    snapshot.bars.some((bar) => !bar.final)
  ) {
    return fail('snapshot-coverage', 'intraday snapshot exceeds the bounded rolling decision evidence')
  }

  const rangeEndNanos = intradayInstantNanos(manifest.rangeEndAt)
  const observedNanos = intradayInstantNanos(manifest.observedAt)
  for (const symbol of protocol.universe) {
    const bars = snapshot.bars
      .filter((bar) => bar.symbol === symbol)
      .toSorted((left, right) => compareIntradayInstants(left.eventAt, right.eventAt))
    if (bars[0]?.eventAt !== manifest.rangeStartAt) {
      return fail('snapshot-coverage', 'intraday symbol lacks the complete rolling lookback baseline', { symbol })
    }
    for (const records of [
      snapshot.quotes.filter((quote) => quote.symbol === symbol).toSorted(compareLatest),
      snapshot.trades.filter((trade) => trade.symbol === symbol).toSorted(compareLatest),
    ] as const) {
      const latest = records[0]
      if (
        latest === undefined ||
        intradayInstantNanos(latest.eventAt) < rangeEndNanos ||
        intradayInstantNanos(latest.eventAt) > observedNanos
      ) {
        return fail('snapshot-coverage', 'intraday decision lacks post-window quote or trade evidence', { symbol })
      }
      if (
        records.some(
          (record) =>
            record !== latest &&
            compareIntradayInstants(record.eventAt, latest.eventAt) === 0 &&
            (record.sourceTopic !== latest.sourceTopic || record.sourcePartition !== latest.sourcePartition),
        )
      ) {
        return fail('snapshot-coverage', 'intraday latest evidence is ambiguous across Kafka partitions', { symbol })
      }
    }
  }
  return Result.succeed(undefined)
}

const signalFor = (
  symbol: string,
  bars: readonly IntradayBar[],
  quote: IntradayQuote,
  trade: IntradayTrade,
  protocol: IntradayMomentumProtocol,
  observedAt: string,
): Result.Result<IntradayMomentumSignal, IntradayMomentumFailure> => {
  const ordered = bars.toSorted((left, right) => compareIntradayInstants(left.eventAt, right.eventAt))
  const first = ordered[0]
  if (first === undefined) return fail('snapshot-coverage', 'intraday symbol has no rolling bars', { symbol })
  return Result.gen(function* () {
    const reference = yield* finite(first.open, 'lookback-open', symbol, true)
    const highs = yield* Result.all(ordered.map((bar) => finite(bar.high, 'bar-high', symbol, true)))
    const lows = yield* Result.all(ordered.map((bar) => finite(bar.low, 'bar-low', symbol, true)))
    const bid = yield* finite(quote.bidPrice, 'quote-bid', symbol, true)
    const ask = yield* finite(quote.askPrice, 'quote-ask', symbol, true)
    const bidSize = yield* finite(quote.bidSize, 'quote-bid-size', symbol, false)
    const askSize = yield* finite(quote.askSize, 'quote-ask-size', symbol, false)
    const tradePrice = yield* finite(trade.price, 'trade-price', symbol, true)
    if (ask < bid) return yield* fail('market-value', 'intraday quote is crossed', { symbol })
    const prices = yield* Result.all({
      reference: scaledInteger(reference, 'lookback-open', symbol),
      high: scaledInteger(Math.max(...highs), 'range-high', symbol),
      low: scaledInteger(Math.min(...lows), 'range-low', symbol),
      bid: scaledInteger(bid, 'quote-bid', symbol),
      ask: scaledInteger(ask, 'quote-ask', symbol),
      trade: scaledInteger(tradePrice, 'trade-price', symbol),
    })
    const metrics = yield* deriveSignalMetrics(prices, symbol)
    const rejectionReasons: IntradayMomentumRejectionReason[] = []
    if (metrics.lookbackReturnBps < protocol.minimumLookbackReturnBps) rejectionReasons.push('lookback-return')
    if (metrics.breakoutBps < protocol.minimumBreakoutBps) rejectionReasons.push('breakout')
    if (metrics.rangeLocationPpm < protocol.minimumRangeLocationPpm) rejectionReasons.push('range-location')
    if (metrics.spreadBps > protocol.maximumSpreadBps) rejectionReasons.push('spread')
    if (bidSize === 0 || askSize === 0) rejectionReasons.push('displayed-liquidity')
    const maximumAge = millisecondsAsNanos(protocol.maximumQuoteAgeMs)
    if (
      intradayAgeNanos(observedAt, quote.eventAt) > maximumAge ||
      intradayAgeNanos(observedAt, trade.eventAt) > maximumAge
    ) {
      rejectionReasons.push('market-data-freshness')
    }
    return Object.freeze({
      symbol,
      referencePriceMicros: String(prices.reference),
      rangeHighPriceMicros: String(prices.high),
      rangeLowPriceMicros: String(prices.low),
      bidPriceMicros: String(prices.bid),
      askPriceMicros: String(prices.ask),
      quoteObservedAt: quote.eventAt,
      confirmationTradePriceMicros: String(prices.trade),
      confirmationTradeObservedAt: trade.eventAt,
      ...metrics,
      eligible: rejectionReasons.length === 0,
      rejectionReasons: Object.freeze(rejectionReasons),
      rank: null,
    })
  })
}

const compareEligible = (left: IntradayMomentumSignal, right: IntradayMomentumSignal): number =>
  right.lookbackReturnBps - left.lookbackReturnBps ||
  right.breakoutBps - left.breakoutBps ||
  right.rangeLocationPpm - left.rangeLocationPpm ||
  left.symbol.localeCompare(right.symbol)

export const decideIntradayMomentum = (
  context: IntradayMomentumMarketContext,
  protocol: IntradayMomentumProtocol,
): Result.Result<IntradayMomentumTargetPortfolio, IntradayMomentumFailure> =>
  Result.gen(function* () {
    const snapshot = yield* Result.mapError(
      reverifyIntradayMarketSnapshot(context.snapshot),
      (cause) =>
        new IntradayMomentumFailure({
          reason:
            cause.reason === 'identity'
              ? 'snapshot-identity'
              : cause.reason === 'request'
                ? 'snapshot-window'
                : 'snapshot-coverage',
          message: `intraday snapshot failed authoritative re-verification: ${cause.message}`,
          cause,
        }),
    )
    yield* validateSnapshot({ ...context, snapshot }, protocol)
    const signals = yield* Result.all(
      protocol.universe.map((symbol) => {
        const quote = snapshot.latestQuotes[symbol]
        const trade = snapshot.trades.filter((candidate) => candidate.symbol === symbol).toSorted(compareLatest)[0]
        return quote === undefined || trade === undefined
          ? fail('snapshot-coverage', 'intraday decision lacks quote or trade confirmation', { symbol })
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
    return Object.freeze({
      schemaVersion: 'bayn.intraday-momentum.target.v1',
      strategy: 'intraday-momentum',
      sessionDate: snapshot.manifest.sessionDate,
      snapshotId: snapshot.manifest.snapshotId,
      observedAt: snapshot.manifest.observedAt,
      calendarHash: context.session.calendarHash,
      selectedSymbols,
      targetWeights: Object.freeze(
        Object.fromEntries(protocol.universe.map((symbol) => [symbol, selectedSet.has(symbol) ? targetWeight : 0])),
      ),
      signals: rankedSignals,
    })
  })

export const makeIntradayMomentumDefinition = (
  protocol: IntradayMomentumProtocol,
): IntradayMomentumStrategyDefinition => ({
  name: 'intraday-momentum',
  holdingPeriod: 'INTRADAY',
  parameters: protocol,
  decide: (context: VerifiedStrategyContext<IntradayMomentumMarketContext>) =>
    decideIntradayMomentum(context.market, protocol),
})
