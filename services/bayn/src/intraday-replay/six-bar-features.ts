import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { jevEntryQuoteExclusion } from '../jev/trading-signals'
import { BarPublicationPolicy } from '../market-data/intraday/bar-publication'
import {
  IntradayCandidateEvidencePolicy,
  IntradayIngestionDelayDirection,
  type IntradayBar,
  type IntradayQuote,
  type IntradaySnapshotQuery,
  type IntradayTrade,
} from '../market-data/intraday/model'
import { intradayInstantNanos } from '../market-data/intraday/time'
import {
  candidateAvailability,
  validateBarStructure,
  validateIdentity,
  validateSourceTopics,
  verifyIntradaySnapshotQuery,
} from '../market-data/intraday/verification'
import { SimulatedSnapshotSourceSchema } from '../market-data/streaming/evidence-schema'
import type { HistoricalMarketCursor } from '../market-data/streaming/historical'
import {
  discardedRejectionsOverlap,
  observedBarsAt,
  observedQuoteAt,
  topicPartitionKey,
  type ObservedMarketValue,
} from '../market-data/streaming/projection'
import { strictParseOptions } from '../schemas'
import { replayQuoteRejection, ReplayQuoteRejection } from './broker-execution-evidence'

export const sixBarResearchDefinition = {
  schemaVersion: 'bayn.six-bar-research-definition.v1',
  benchmarkSymbol: 'SPY',
  completedBarsPerSymbol: 6,
  minuteMs: 60_000,
  minimumWatermarkLagMs: 2_000,
  maximumQuoteAgeMs: 10_000,
  maximumSpreadBps: 5,
  producerClockSkewAllowanceMs: 0,
  barPublicationPolicy: BarPublicationPolicy.TimelyEquivalentRevision,
  candidateEvidencePolicy: IntradayCandidateEvidencePolicy.QuoteWithWindowTrade,
  quotePolicy: 'Both symbols require positive displayed sizes and spread at most five basis points.',
  benchmarkTradePolicy: 'Post-window trade with observation age between zero and ten seconds.',
  features: [
    'candidate-simple-1m-close-return',
    'candidate-minus-SPY-simple-5m-close-return',
    'SPY-simple-5m-close-return',
    'candidate-five-log-return-root-sum-squares',
    'IEX-spread-bps',
    'displayed-size-imbalance',
    'elapsed-calendar-session-fraction',
  ],
} as const

export enum SixBarResearchStatus {
  Available = 'AVAILABLE',
  Excluded = 'EXCLUDED',
  Unavailable = 'UNAVAILABLE',
}

export enum SixBarUnavailableReason {
  RetainedCut = 'retained-cut-unavailable',
  Bars = 'six-contiguous-bars-unavailable',
  Quote = 'quote-unavailable',
  Trade = 'trade-unavailable',
  Freshness = 'input-freshness',
  BenchmarkTrade = 'benchmark-trade-stale',
}

export type SixBarFeatureValues = readonly [number, number, number, number, number, number, number]
type Outcome =
  | { readonly status: SixBarResearchStatus.Available; readonly values: SixBarFeatureValues }
  | {
      readonly status: SixBarResearchStatus.Excluded
      readonly symbol: string
      readonly reason: NonNullable<Result.Result.Success<ReturnType<typeof jevEntryQuoteExclusion>>>
    }
  | {
      readonly status: SixBarResearchStatus.Unavailable
      readonly symbol: string | null
      readonly reason: SixBarUnavailableReason
      readonly message: string
      readonly missingBarInstants: readonly string[]
    }

export class SixBarResearchFailure extends Data.TaggedError('SixBarResearchFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const fail = (message: string, cause?: unknown) => new SixBarResearchFailure({ message, cause })
type RecordEntry = ObservedMarketValue<IntradayBar | IntradayQuote | IntradayTrade>

/** Research evidence only. The cursor must come from verified original-capture replay, advanced no later than observation. */
export const extractSixBarResearchObservation = (cursor: HistoricalMarketCursor, query: IntradaySnapshotQuery) =>
  Result.gen(function* () {
    const request = yield* verifyIntradaySnapshotQuery(query)
    const source = yield* Schema.decodeUnknownResult(SimulatedSnapshotSourceSchema, strictParseOptions)(cursor.source)
    const candidate = request.candidateSymbols?.[0]
    const observedAtMs = Date.parse(request.observedAt)
    const start = intradayInstantNanos(request.rangeStartAt)
    const end = intradayInstantNanos(request.rangeEndAt)
    const minute = 60_000_000_000n
    const session = request.calendar.sessions.find((entry) => entry.date === request.sessionDate)
    if (
      candidate === undefined ||
      candidate === sixBarResearchDefinition.benchmarkSymbol ||
      request.candidateSymbols?.length !== 1 ||
      request.symbols?.length !== 2 ||
      !request.symbols.includes(sixBarResearchDefinition.benchmarkSymbol) ||
      request.purpose !== undefined ||
      end - start !== 6n * minute ||
      request.maximumQuoteAgeMs !== sixBarResearchDefinition.maximumQuoteAgeMs ||
      request.minimumWatermarkLagMs !== sixBarResearchDefinition.minimumWatermarkLagMs ||
      request.candidateEvidencePolicy !== sixBarResearchDefinition.candidateEvidencePolicy ||
      request.feed !== 'iex' ||
      request.delayClass !== 'real_time_exchange_only' ||
      session === undefined ||
      observedAtMs >= Date.parse(session.closeAt)
    )
      return yield* Result.fail(
        fail('Six-bar research requires its exact candidate, benchmark, window and timing contract'),
      )
    if (
      source.deliveryModel.schemaVersion !== 'bayn.original-capture-arrivals.v1' ||
      source.runId !== cursor.runId ||
      cursor.projection.availabilityMode !== 'simulated' ||
      source.featureTopic !== cursor.universe.topics.features ||
      source.technicalFeatureTopic !== cursor.universe.topics.technicalFeatures ||
      source.regeneratedFeaturesRecordedAtMs !== undefined ||
      source.regeneratedTechnicalFeaturesRecordedAtMs !== undefined ||
      cursor.regeneratedFeaturesRecordedAtMs !== undefined ||
      cursor.regeneratedTechnicalFeaturesRecordedAtMs !== undefined ||
      cursor.universe.universeId !== request.universeId ||
      cursor.universe.universeSymbolHash !== request.universeSymbolHash ||
      cursor.universe.symbols.join(',') !== request.universe.join(',') ||
      cursor.universe.topics.bars !== request.sourceTopics.bars ||
      cursor.universe.topics.quotes !== request.sourceTopics.quotes ||
      cursor.universe.topics.trades !== request.sourceTopics.trades ||
      (cursor.lastArrival !== null &&
        (cursor.lastArrival.availableAtMs > observedAtMs ||
          cursor.lastArrival.receipt === undefined ||
          !('consumerSequence' in cursor.lastArrival.receipt)))
    )
      return yield* Result.fail(
        fail('Six-bar research requires a matching original-byte receipt cursor at the observation cut'),
      )
    const state = cursor.projection
    const selected = request.symbols.map((symbol) => ({
      symbol,
      bars: observedBarsAt(state, symbol, start, end, observedAtMs),
      quote: observedQuoteAt(state, symbol, observedAtMs),
      trade: state.tradeHistory.get(symbol)?.findLast((entry) => entry.availableAtMs <= observedAtMs),
    }))
    const entries: RecordEntry[] = []
    const publications: IntradayBar[] = []
    for (const input of selected) {
      entries.push(...input.bars)
      for (const bar of input.bars) {
        const witness = bar.firstPublication
        if (witness !== undefined) {
          if (witness.availableAtMs > observedAtMs || witness.sequence >= bar.sequence)
            return yield* Result.fail(fail('Bar publication witness is outside the observed cut'))
          entries.push(witness)
        }
        publications.push((witness ?? bar).value)
      }
      if (input.quote !== undefined) entries.push(input.quote)
      if (input.trade !== undefined) entries.push(input.trade)
    }
    const receipts = []
    for (const entry of entries) {
      const value = entry.value
      if (intradayInstantNanos(value.ingestedAt) > BigInt(entry.availableAtMs) * 1_000_000n)
        return yield* Result.fail(
          fail('Selected record precedes its producer publication under the zero-skew research contract'),
        )
      const offset = state.offsets.get(topicPartitionKey(value.sourceTopic, value.sourcePartition))
      if (
        entry.availableAtMs > observedAtMs ||
        entry.sequence > state.sequence ||
        offset === undefined ||
        BigInt(value.sourceOffset) > BigInt(offset)
      )
        return yield* Result.fail(fail('Selected record is outside the original receipt cut'))
      receipts.push({
        symbol: value.symbol,
        eventAt: value.eventAt,
        sourceTopic: value.sourceTopic,
        sourcePartition: value.sourcePartition,
        sourceOffset: value.sourceOffset,
        availableAtMs: entry.availableAtMs,
        projectionSequence: entry.sequence,
        recordTextSha256: entry.recordHash,
        normalizedContentHash: yield* canonicalHashV1Result(value),
      })
    }
    const evidence = {
      schemaVersion: 'bayn.six-bar-research-observation.v1' as const,
      qualification: 'UNQUALIFIED' as const,
      controllerCoverage: 'UNKNOWN' as const,
      definitionHash: yield* canonicalHashV1Result(sixBarResearchDefinition),
      candidateSymbol: candidate,
      query: request,
      source,
      cut: { sequence: state.sequence, lastArrival: cursor.lastArrival },
      receipts,
    }
    const finish = (outcome: Outcome) =>
      canonicalHashV1Result({ ...evidence, ...outcome }).pipe(
        Result.map((evidenceHash) => ({ ...evidence, ...outcome, evidenceHash })),
      )
    const unavailable = (
      reason: SixBarUnavailableReason,
      message: string,
      symbol: string | null = null,
      missingBarInstants: readonly string[] = [],
    ) => finish({ status: SixBarResearchStatus.Unavailable, reason, message, symbol, missingBarInstants })
    const inputIssues: Exclude<Outcome, { status: SixBarResearchStatus.Available }>[] = []
    const recordUnavailable = (
      reason: SixBarUnavailableReason,
      message: string,
      symbol: string | null = null,
      missingBarInstants: readonly string[] = [],
    ) => {
      inputIssues.push({ status: SixBarResearchStatus.Unavailable, reason, message, symbol, missingBarInstants })
    }
    if (
      state.minimumObservationMs > observedAtMs ||
      discardedRejectionsOverlap(state, Date.parse(request.rangeStartAt))
    )
      return yield* unavailable(SixBarUnavailableReason.RetainedCut, 'No complete retained cut for this observation')
    for (const history of state.rejections.values())
      if (
        history.some(
          (entry) => entry.availableAtMs >= Date.parse(request.rangeStartAt) && entry.availableAtMs <= observedAtMs,
        )
      )
        return yield* Result.fail(fail('The observed cut contains rejected input'))
    const bars = selected.flatMap((input) => input.bars.map((entry) => entry.value))
    const quotes = selected.flatMap((input) => (input.quote === undefined ? [] : [input.quote.value]))
    const trades = selected.flatMap((input) => (input.trade === undefined ? [] : [input.trade.value]))
    yield* validateSourceTopics(request, bars, quotes, trades)
    yield* validateIdentity(request, bars, request.rangeEndAt, false)
    yield* validateIdentity(request, publications, request.rangeEndAt, false)
    yield* validateIdentity(request, [...quotes, ...trades], request.observedAt, true)
    yield* validateBarStructure(request, bars)
    yield* validateBarStructure(request, publications)
    for (const input of selected) {
      const present = new Set(input.bars.map((entry) => intradayInstantNanos(entry.value.eventAt)))
      const missing: string[] = []
      for (let at = start; at < end; at += minute)
        if (!present.has(at)) missing.push(new Date(Number(at / 1_000_000n)).toISOString())
      if (input.bars.length !== 6 || missing.length > 0)
        recordUnavailable(
          SixBarUnavailableReason.Bars,
          'Six exact contiguous completed RTH bars are required',
          input.symbol,
          missing,
        )
      const quoteReason = replayQuoteRejection(input.quote, input.symbol, observedAtMs, request)
      if (quoteReason !== null) {
        if (quoteReason !== ReplayQuoteRejection.Missing && quoteReason !== ReplayQuoteRejection.Stale)
          return yield* Result.fail(fail(`Invalid quote for ${input.symbol}: ${quoteReason}`))
        recordUnavailable(SixBarUnavailableReason.Quote, quoteReason, input.symbol)
      }
      if (input.trade === undefined)
        recordUnavailable(SixBarUnavailableReason.Trade, 'A real observed trade is required', input.symbol)
      if (
        input.symbol === sixBarResearchDefinition.benchmarkSymbol &&
        input.trade !== undefined &&
        BigInt(observedAtMs) * 1_000_000n - intradayInstantNanos(input.trade.value.eventAt) > 10_000_000_000n
      )
        recordUnavailable(
          SixBarUnavailableReason.BenchmarkTrade,
          'SPY trade exceeds the ten-second observation-age bound',
          input.symbol,
        )
    }
    const availability = candidateAvailability(
      request,
      publications,
      quotes,
      trades,
      0,
      BarPublicationPolicy.TimelyEquivalentRevision,
    )
    if (Result.isFailure(availability)) {
      const cause = availability.failure
      if (
        cause.reason === 'not-ready' ||
        (cause.reason === 'freshness' && cause.ingestionDelayDirection === IntradayIngestionDelayDirection.AboveMaximum)
      )
        recordUnavailable(SixBarUnavailableReason.Freshness, cause.message)
      else return yield* Result.fail(cause)
    }
    const exclusion = Result.isSuccess(availability) ? availability.success.exclusions[0] : undefined
    if (exclusion !== undefined)
      recordUnavailable(SixBarUnavailableReason.Freshness, exclusion.message, exclusion.symbol)
    for (const quote of quotes) {
      const reason = yield* jevEntryQuoteExclusion(quote, sixBarResearchDefinition.maximumSpreadBps)
      if (reason !== null) inputIssues.push({ status: SixBarResearchStatus.Excluded, symbol: quote.symbol, reason })
    }
    // A candidate-local gap must never hide invalid required benchmark evidence.
    const issue = inputIssues.find((entry) => entry.symbol !== candidate) ?? inputIssues[0]
    if (issue !== undefined) return yield* finish(issue)
    const candidateInput = selected.find((input) => input.symbol === candidate)
    const benchmarkInput = selected.find((input) => input.symbol === sixBarResearchDefinition.benchmarkSymbol)
    const closes = candidateInput?.bars.map((entry) => entry.value.close) ?? []
    const benchmark = benchmarkInput?.bars.map((entry) => entry.value.close) ?? []
    const first = closes[0],
      previous = closes[4],
      last = closes[5]
    const benchmarkFirst = benchmark[0],
      benchmarkLast = benchmark[5],
      quote = candidateInput?.quote?.value
    if (
      first === undefined ||
      previous === undefined ||
      last === undefined ||
      benchmarkFirst === undefined ||
      benchmarkLast === undefined ||
      quote === undefined
    )
      return yield* Result.fail(fail('Validated six-bar inputs are incomplete'))
    let squaredLogReturns = 0
    for (let index = 1; index < closes.length; index++) {
      const current = closes[index],
        prior = closes[index - 1]
      if (current === undefined || prior === undefined)
        return yield* Result.fail(fail('Validated close pair is missing'))
      squaredLogReturns += Math.log(current / prior) ** 2
    }
    const benchmarkReturn = benchmarkLast / benchmarkFirst - 1
    const values: SixBarFeatureValues = [
      last / previous - 1,
      last / first - 1 - benchmarkReturn,
      benchmarkReturn,
      Math.sqrt(squaredLogReturns),
      ((quote.askPrice - quote.bidPrice) / ((quote.askPrice + quote.bidPrice) / 2)) * 10_000,
      (quote.bidSize - quote.askSize) / (quote.bidSize + quote.askSize),
      (observedAtMs - Date.parse(session.openAt)) / (Date.parse(session.closeAt) - Date.parse(session.openAt)),
    ]
    if (!values.every(Number.isFinite))
      return yield* Result.fail(fail('Six-bar calculation produced a nonfinite value'))
    return yield* finish({ status: SixBarResearchStatus.Available, values })
  }).pipe(Result.mapError((cause) => fail('Invalid six-bar research observation', cause)))
