import { Data, Result, Schema } from 'effect'
import { MarketCalendarResponseSchema } from '../../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../../broker/alpaca/normalizers'
import { IsoDateSchema } from '../../contracts'
import { canonicalHashV1Result } from '../../hash'
import { Sha256Schema, strictParseOptions } from '../../schemas'
import {
  decideIntradayMomentumCore,
  type IntradayMomentumRollingPrices,
} from '../../strategy/intraday-momentum/decision-core'
import { intradayMomentumBehaviorHash } from '../../strategy/intraday-momentum/decision'
import {
  decodeDefaultIntradayMomentumProtocol,
  hashIntradayMomentumProtocol,
  intradayMomentumFeatureTopic,
  intradayMomentumSnapshotSymbols,
} from '../../strategy/intraday-momentum/protocol'
import { marketFeatureClockSkewAllowanceMs } from '../features/contract'
import {
  candidateAvailability,
  validateBarStructure,
  validateIdentity,
  verifyIntradaySnapshotQuery,
} from '../intraday/verification'
import { HistoricalStreamingInputSchema, replayHistoricalMarketArrivals } from './historical'
import { observedBarsAt, selectStreamingSymbolInputs } from './projection'

export const HistoricalStreamingStrategyInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.historical-streaming-strategy-input.v1'),
  protocolHash: Sha256Schema,
  behaviorHash: Sha256Schema,
  sessionDate: IsoDateSchema,
  calendar: MarketCalendarResponseSchema,
  arrivals: HistoricalStreamingInputSchema,
})

class HistoricalStreamingStrategyFailure extends Data.TaggedError('HistoricalStreamingStrategyFailure')<{
  readonly message: string
}> {}

/** Research only: this receipt cannot construct a verified execution snapshot or an order. */
export const replayHistoricalStreamingStrategy = (input: unknown) =>
  Result.gen(function* () {
    const decoded = yield* Schema.decodeUnknownResult(HistoricalStreamingStrategyInputSchema, strictParseOptions)(input)
    const protocol = yield* decodeDefaultIntradayMomentumProtocol()
    const protocolHash = yield* hashIntradayMomentumProtocol(protocol)
    if (protocolHash !== decoded.protocolHash || decoded.behaviorHash !== intradayMomentumBehaviorHash)
      return yield* Result.fail(
        new HistoricalStreamingStrategyFailure({ message: 'Historical protocol hash differs from this runtime' }),
      )
    const calendar = yield* normalizeMarketCalendarResult(decoded.calendar, {
      start: decoded.sessionDate,
      end: decoded.sessionDate,
    })
    const session = calendar.sessions.find((entry) => entry.date === decoded.sessionDate)
    const observedAtMs = decoded.arrivals.observedAtMs
    const windowEndMs = Math.floor((observedAtMs - protocol.decisionDelaySeconds * 1000) / 60_000) * 60_000
    const windowStartMs = windowEndMs - protocol.lookbackMinutes * 60_000
    if (
      session === undefined ||
      !Number.isSafeInteger(observedAtMs) ||
      observedAtMs > 8_640_000_000_000_000 ||
      windowStartMs < Date.parse(session.openAt) ||
      observedAtMs < Date.parse(session.openAt) + protocol.warmupMinutesAfterOpen * 60_000 ||
      observedAtMs >= Date.parse(session.closeAt) - protocol.entryCutoffMinutesBeforeClose * 60_000
    )
      return yield* Result.fail(
        new HistoricalStreamingStrategyFailure({
          message: 'Historical observation is outside the selected session decision interval',
        }),
      )
    const query = yield* verifyIntradaySnapshotQuery({
      calendar,
      sessionDate: decoded.sessionDate,
      observedAt: new Date(observedAtMs).toISOString(),
      rangeStartAt: new Date(windowStartMs).toISOString(),
      rangeEndAt: new Date(windowEndMs).toISOString(),
      universeId: protocol.universeId,
      universeSymbolHash: protocol.universeSymbolHash,
      universe: protocol.universe,
      symbols: intradayMomentumSnapshotSymbols(protocol),
      candidateSymbols: protocol.candidateSymbols,
      feed: protocol.feed,
      delayClass: protocol.delayClass,
      sourceTopics: protocol.sourceTopics,
      maximumQuoteAgeMs: protocol.maximumQuoteAgeMs,
      minimumWatermarkLagMs: protocol.decisionDelaySeconds * 1000,
    })
    const replay = yield* replayHistoricalMarketArrivals(decoded.arrivals, {
      universeId: protocol.universeId,
      universeSymbolHash: protocol.universeSymbolHash,
      symbols: protocol.universe,
      topics: { ...protocol.sourceTopics, features: intradayMomentumFeatureTopic },
    })
    const state = replay.projection
    if (
      state.minimumObservationMs > observedAtMs ||
      windowStartMs <= state.discardedRejectionsThroughMs ||
      [...state.rejections.values()].some((history) =>
        history.some((entry) => entry.availableAtMs >= windowStartMs && entry.availableAtMs <= observedAtMs),
      )
    )
      return yield* Result.fail(
        new HistoricalStreamingStrategyFailure({
          message: 'Historical input contains rejected records or incomplete retained history',
        }),
      )
    const symbols = intradayMomentumSnapshotSymbols(protocol)
    const bars = symbols.flatMap((symbol) =>
      observedBarsAt(
        state,
        symbol,
        BigInt(windowStartMs) * 1_000_000n,
        BigInt(windowEndMs) * 1_000_000n,
        observedAtMs,
      ).map((entry) => entry.value),
    )
    const quotes = symbols.flatMap((symbol) => {
      const entry = state.quoteHistory.get(symbol)?.findLast((value) => value.availableAtMs <= observedAtMs)
      return entry === undefined ? [] : [entry.value]
    })
    const trades = symbols.flatMap((symbol) => {
      const entry = state.tradeHistory.get(symbol)?.findLast((value) => value.availableAtMs <= observedAtMs)
      return entry === undefined ? [] : [entry.value]
    })
    yield* validateIdentity(query, bars, query.rangeEndAt, false, undefined, marketFeatureClockSkewAllowanceMs)
    yield* validateIdentity(
      query,
      [...quotes, ...trades],
      session.closeAt,
      true,
      undefined,
      marketFeatureClockSkewAllowanceMs,
    )
    yield* validateBarStructure(query, bars, marketFeatureClockSkewAllowanceMs)
    const availability = yield* candidateAvailability(query, bars, quotes, trades, marketFeatureClockSkewAllowanceMs)
    const exclusions = new Map(availability.exclusions.map((entry) => [entry.symbol, entry]))
    const rollingPrices: Record<string, IntradayMomentumRollingPrices> = {}
    const features = []
    for (const symbol of symbols) {
      const selected = selectStreamingSymbolInputs(state, symbol, windowStartMs, windowEndMs, observedAtMs)
      if (Result.isFailure(selected)) {
        if (symbol === protocol.benchmarkSymbol) return yield* Result.fail(selected.failure)
        if (!exclusions.has(symbol))
          exclusions.set(symbol, { symbol, reason: 'not-ready', message: selected.failure.message })
        continue
      }
      const feature = selected.success.feature
      rollingPrices[symbol] = feature.value.material.values
      features.push({
        symbol,
        topic: feature.topic,
        partition: feature.partition,
        offset: feature.offset,
        simulatedAvailableAtMs: feature.availableAtMs,
        value: feature.value,
      })
    }
    if (exclusions.size === protocol.candidateSymbols.length)
      return yield* Result.fail(
        new HistoricalStreamingStrategyFailure({ message: 'Every historical candidate is unavailable' }),
      )
    const decision = yield* decideIntradayMomentumCore({
      protocol,
      bars,
      rollingPrices,
      latestQuotes: Object.fromEntries(quotes.map((quote) => [quote.symbol, quote])),
      latestTrades: Object.fromEntries(trades.map((trade) => [trade.symbol, trade])),
      observedAt: query.observedAt,
      rangeStartAt: query.rangeStartAt,
      candidateExclusions: [...exclusions.values()].toSorted((a, b) => a.symbol.localeCompare(b.symbol)),
    })
    const receipt = {
      schemaVersion: 'bayn.historical-streaming-strategy-receipt.v1',
      evidenceMode: replay.evidenceMode,
      runId: replay.runId,
      inputHash: yield* canonicalHashV1Result(decoded),
      arrivalsHash: replay.inputHash,
      protocolHash,
      behaviorHash: intradayMomentumBehaviorHash,
      deliveryModel: replay.deliveryModel,
      regeneratedFeatures: replay.regeneratedFeatures ?? null,
      calendar,
      observedAt: query.observedAt,
      rangeStartAt: query.rangeStartAt,
      rangeEndAt: query.rangeEndAt,
      features,
      decision,
    }
    return { ...receipt, receiptHash: yield* canonicalHashV1Result(receipt) }
  })
