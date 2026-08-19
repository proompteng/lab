import { Result } from 'effect'

import { sha256 } from '../../hash'
import type { IntradayBar, IntradayQuote, IntradayTrade } from '../../market-data'
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

export const openingDriveBehaviorVersion = 'bayn.opening-drive-momentum.behavior.v1' as const
export const openingDriveBehaviorHash = sha256(openingDriveBehaviorVersion)

const compareCanonicalText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const compareLatestTrade = (left: IntradayTrade, right: IntradayTrade): number => {
  const eventOrder = compareCanonicalText(right.eventAt, left.eventAt)
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

const validateSnapshot = (
  context: OpeningDriveMarketContext,
  protocol: OpeningDriveProtocol,
): Result.Result<void, OpeningDriveFailure> => {
  const { session, snapshot } = context
  const manifest = snapshot.manifest
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
  const sessionOpen = Date.parse(session.openAt)
  const sessionClose = Date.parse(session.closeAt)
  const entryCutoff = sessionOpen + protocol.entryCutoffMinutesAfterOpen * 60_000
  const flattenAt = sessionClose - protocol.flattenBeforeCloseMinutes * 60_000
  const earliestDecision = rangeEnd + protocol.decisionDelaySeconds * 1_000
  const decisionWindowEnd = Math.min(entryCutoff, flattenAt)
  if (
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
    session.openAt !== manifest.rangeStartAt ||
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
    const quote = snapshot.latestQuotes[symbol]
    const quoteEvent = quote === undefined ? Number.NaN : Date.parse(quote.eventAt)
    if (
      quote === undefined ||
      quote.symbol !== symbol ||
      !Number.isFinite(quoteEvent) ||
      quoteEvent < rangeEnd ||
      quoteEvent > observed ||
      observed - quoteEvent > protocol.maximumQuoteAgeMs
    ) {
      return fail('snapshot-coverage', 'opening-drive decision lacks a fresh post-range quote', { symbol })
    }
    const latestTrade = snapshot.trades.filter((trade) => trade.symbol === symbol).toSorted(compareLatestTrade)[0]
    const tradeEvent = latestTrade === undefined ? Number.NaN : Date.parse(latestTrade.eventAt)
    if (
      latestTrade === undefined ||
      !Number.isFinite(tradeEvent) ||
      tradeEvent < rangeEnd ||
      tradeEvent > observed ||
      observed - tradeEvent > protocol.maximumQuoteAgeMs
    ) {
      return fail('snapshot-coverage', 'opening-drive decision lacks a fresh post-range trade', { symbol })
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
    const tradePrice = yield* finite(trade.price, 'trade-price', symbol, true)
    if (ask < bid) return yield* fail('market-value', 'opening-drive quote is crossed', { symbol })
    const high = Math.max(...highs)
    const low = Math.min(...lows)
    const midpoint = (bid + ask) / 2
    const openingReturnBps = Math.floor((midpoint / open - 1) * 10_000)
    const breakoutBps = Math.floor((Math.min(ask, tradePrice) / high - 1) * 10_000)
    const spreadBps = Math.ceil(((ask - bid) / midpoint) * 10_000)
    const rangeLocationPpm =
      high === low ? 0 : Math.floor(Math.min(1, Math.max(0, (midpoint - low) / (high - low))) * 1_000_000)
    if (![openingReturnBps, breakoutBps, spreadBps, rangeLocationPpm].every(Number.isSafeInteger)) {
      return yield* fail('market-value', 'opening-drive derived signal exceeds the exact integer domain', { symbol })
    }
    const dollarVolume = yield* openingDollarVolume(symbol, orderedBars)
    const minimumDollarVolume = BigInt(protocol.minimumOpeningDollarVolumeMicros)
    const rejectionReasons: OpeningDriveRejectionReason[] = []
    if (openingReturnBps < protocol.minimumOpeningReturnBps) rejectionReasons.push('opening-return')
    if (breakoutBps < protocol.minimumBreakoutBps) rejectionReasons.push('breakout')
    if (rangeLocationPpm < protocol.minimumRangeLocationPpm) rejectionReasons.push('range-location')
    if (spreadBps > protocol.maximumSpreadBps) rejectionReasons.push('spread')
    if (dollarVolume < minimumDollarVolume) rejectionReasons.push('dollar-volume')
    const prices = yield* Result.all({
      opening: scaledInteger(open, 'opening-price', symbol, 'round'),
      high: scaledInteger(high, 'range-high', symbol, 'round'),
      low: scaledInteger(low, 'range-low', symbol, 'round'),
      bid: scaledInteger(bid, 'quote-bid', symbol, 'round'),
      ask: scaledInteger(ask, 'quote-ask', symbol, 'round'),
      trade: scaledInteger(tradePrice, 'trade-price', symbol, 'round'),
    })
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
    const { session, snapshot } = context
    yield* validateSnapshot(context, protocol)
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
