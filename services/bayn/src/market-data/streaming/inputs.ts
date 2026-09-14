import { Result } from 'effect'

import {
  IntradaySnapshotFailure,
  type IntradayBar,
  type IntradayQuote,
  type IntradayTrade,
  type IntradayCandidateExclusion,
  type IntradaySnapshotQuery,
} from '../intraday/model'
import { intradayInstantNanos } from '../intraday/time'
import {
  candidateAvailability,
  compareRecords,
  validateBarStructure,
  validateIdentity,
  validateSourceTopics,
  verifyIntradaySnapshotQuery,
} from '../intraday/verification'
import { featureMatchesBars, marketFeatureClockSkewAllowanceMs } from '../features/contract'
import { observedBarsAt, type StreamingProjection, type ObservedMarketValue } from './projection'
import { technicalFeatureMatchesBars, type TechnicalMarketFeature } from '../features/technical-contract'
import { technicalReceiptAvailableAt } from './technical-projection'
import type { StreamingFeatureReceipt } from './snapshot'

const failure = (reason: IntradaySnapshotFailure['reason'], message: string, cause?: unknown) =>
  new IntradaySnapshotFailure({ reason, message, ...(cause === undefined ? {} : { cause }) })
const observedWithin = <A>(entry: ObservedMarketValue<A>, observedAtMs: number) => entry.availableAtMs <= observedAtMs

/** Shared input policy only. This does not issue live snapshot or broker authority. */
export const selectStreamingInputs = (state: StreamingProjection, query: IntradaySnapshotQuery) =>
  Result.gen(function* () {
    const request = yield* verifyIntradaySnapshotQuery(query)
    const observedAtMs = Date.parse(request.observedAt)
    const start = intradayInstantNanos(request.rangeStartAt)
    const end = intradayInstantNanos(request.rangeEndAt)
    if (
      state.minimumObservationMs > observedAtMs ||
      Date.parse(request.rangeStartAt) <= state.discardedRejectionsThroughMs
    )
      return yield* Result.fail(
        failure('not-ready', 'Streaming projection has no complete retained cut for this observation'),
      )
    const session = request.calendar.sessions.find((entry) => entry.date === request.sessionDate)
    if (session === undefined)
      return yield* Result.fail(failure('request', 'Streaming snapshot has no bound exchange session'))
    const symbols = request.symbols ?? request.universe
    const candidates = new Set(request.candidateSymbols)
    const entries: ObservedMarketValue<IntradayBar | IntradayQuote | IntradayTrade>[] = []
    const featureReceipts: StreamingFeatureReceipt[] = []
    const technicalReceipts: StreamingFeatureReceipt<TechnicalMarketFeature>[] = []
    const featureExclusions: IntradayCandidateExclusion[] = []
    for (const [key, history] of state.rejections) {
      const rejection = history.find(
        (entry) => entry.availableAtMs >= Date.parse(request.rangeStartAt) && entry.availableAtMs <= observedAtMs,
      )
      if (rejection !== undefined)
        return yield* Result.fail(
          failure('rows', `Streaming partition ${key} contains rejected input: ${rejection.reason}`),
        )
    }
    for (const symbol of symbols) {
      const bars = observedBarsAt(state, symbol, start, end, observedAtMs)
      const quote = state.quoteHistory.get(symbol)?.findLast((entry) => observedWithin(entry, observedAtMs))
      const trade = state.tradeHistory.get(symbol)?.findLast((entry) => observedWithin(entry, observedAtMs))
      if (request.purpose === undefined) entries.push(...bars)
      if (quote !== undefined) entries.push(quote)
      if (request.purpose === undefined && trade !== undefined) entries.push(trade)
      if (request.purpose !== undefined) continue
      if (state.technicalTopic !== undefined) {
        for (const candidate of state.technicalFeatures.get(symbol) ?? []) {
          if (
            !technicalReceiptAvailableAt(state, candidate, observedAtMs) ||
            candidate.value.material.sessionDate !== request.sessionDate ||
            candidate.value.material.windowEndMs !== Date.parse(request.rangeEndAt)
          )
            continue
          const matched = technicalFeatureMatchesBars(
            candidate.value,
            bars.map((entry) => entry.value),
          )
          if (Result.isFailure(matched) || !matched.success) continue
          technicalReceipts.push({
            topic: candidate.topic,
            partition: candidate.partition,
            offset: candidate.offset,
            availableAtMs: candidate.availableAtMs,
            sequence: candidate.sequence,
            value: candidate.value,
          })
          break
        }
      }
      let selected: StreamingFeatureReceipt | undefined
      for (const candidate of state.features.get(symbol) ?? []) {
        if (
          candidate.availableAtMs > observedAtMs ||
          candidate.value.material.sessionDate !== request.sessionDate ||
          candidate.value.material.windowStartMs !== Date.parse(request.rangeStartAt) ||
          candidate.value.material.windowEndMs !== Date.parse(request.rangeEndAt)
        )
          continue
        const matches = yield* featureMatchesBars(
          candidate.value,
          bars.map((entry) => entry.value),
        ).pipe(Result.mapError((cause) => failure('identity', 'Streaming feature inputs failed verification', cause)))
        if (!matches) continue
        selected = {
          topic: candidate.topic,
          partition: candidate.partition,
          offset: candidate.offset,
          availableAtMs: candidate.availableAtMs,
          sequence: candidate.sequence,
          value: candidate.value,
        }
        break
      }
      if (selected !== undefined) featureReceipts.push(selected)
      else if (candidates.has(symbol))
        featureExclusions.push({
          symbol,
          reason: 'not-ready',
          message: 'matching complete rolling feature is unavailable',
        })
      else return yield* Result.fail(failure('not-ready', `Required rolling feature is unavailable for ${symbol}`))
    }
    const bars = entries
      .map((entry) => entry.value)
      .filter((value): value is IntradayBar => 'open' in value)
      .toSorted(compareRecords)
    const quotes = entries
      .map((entry) => entry.value)
      .filter((value): value is IntradayQuote => 'bidPrice' in value)
      .toSorted(compareRecords)
    const trades = entries
      .map((entry) => entry.value)
      .filter((value): value is IntradayTrade => 'price' in value)
      .toSorted(compareRecords)
    yield* validateSourceTopics(request, bars, quotes, trades)
    yield* validateIdentity(request, bars, request.rangeEndAt, false, undefined, marketFeatureClockSkewAllowanceMs)
    yield* validateIdentity(
      request,
      [...quotes, ...trades],
      session.closeAt,
      true,
      undefined,
      marketFeatureClockSkewAllowanceMs,
    )
    yield* validateBarStructure(request, bars, marketFeatureClockSkewAllowanceMs)
    const availability = yield* candidateAvailability(request, bars, quotes, trades, marketFeatureClockSkewAllowanceMs)
    const exclusions = new Map(availability.exclusions.map((exclusion) => [exclusion.symbol, exclusion]))
    for (const exclusion of featureExclusions)
      if (!exclusions.has(exclusion.symbol)) exclusions.set(exclusion.symbol, exclusion)
    const excluded = new Set(exclusions.keys())
    if (request.purpose === undefined && candidates.size > 0 && [...candidates].every((symbol) => excluded.has(symbol)))
      return yield* Result.fail(
        failure('not-ready', 'No candidate has complete raw data and a matching rolling feature'),
      )
    const technicalFeatures = technicalReceipts.filter((feature) => !excluded.has(feature.value.material.symbol))
    const technical =
      state.technicalTopic === undefined
        ? undefined
        : {
            topic: state.technicalTopic,
            features: technicalFeatures,
            unavailableSymbols: symbols.filter(
              (symbol) => !technicalFeatures.some((feature) => feature.value.material.symbol === symbol),
            ),
          }
    return {
      request,
      symbols,
      entries,
      featureReceipts,
      technical,
      bars,
      quotes,
      trades,
      availability,
      exclusions,
      excluded,
    }
  })
