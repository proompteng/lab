import { snapshotMarketCloseAt } from '../../market-hours'
import { nativeFeatureMatchesBars, rollingWindowStartMs } from '../features/native-feature'
import { isCryptoMarketFeature } from '../features/crypto-contract'
import { Result } from 'effect'

import {
  IntradayCandidateEvidencePolicy,
  IntradaySnapshotFailure,
  IntradaySnapshotPurpose,
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
import {
  marketFeatureClockSkewAllowanceMs,
  MarketFeatureDefinition,
  rollingFeatureDefinitionMaterial,
} from '../features/contract'
import { sha256 } from '../../hash'
import {
  discardedRejectionsOverlap,
  observedBarsAt,
  type StreamingProjection,
  type ObservedMarketValue,
} from './projection'
import { technicalFeatureMatchesBars, type TechnicalMarketFeature } from '../features/technical-contract'
import { technicalReceiptAvailableAt } from './technical-projection'
import type { StreamingFeatureReceipt } from './snapshot'

const failure = (reason: IntradaySnapshotFailure['reason'], message: string, cause?: unknown) =>
  new IntradaySnapshotFailure({ reason, message, ...(cause === undefined ? {} : { cause }) })
const observedWithin = <A>(entry: ObservedMarketValue<A>, observedAtMs: number) => entry.availableAtMs <= observedAtMs
const rollingFeatureDefinitionHash = sha256(JSON.stringify(rollingFeatureDefinitionMaterial))

export const missingMinuteBars = (bars: readonly IntradayBar[], startAt: string, endAt: string) => {
  const start = intradayInstantNanos(startAt)
  const end = intradayInstantNanos(endAt)
  const present = new Set(bars.map((bar) => intradayInstantNanos(bar.eventAt)))
  const missing: string[] = []
  for (let at = start; at < end; at += 60_000_000_000n)
    if (!present.has(at)) missing.push(new Date(Number(at / 1_000_000n)).toISOString())
  return missing
}

/** Shared input policy only. This does not issue live snapshot or broker authority. */
export const selectStreamingInputs = (state: StreamingProjection, query: IntradaySnapshotQuery) =>
  Result.gen(function* () {
    const request = yield* verifyIntradaySnapshotQuery(query)
    const observedAtMs = Date.parse(request.observedAt)
    const start = intradayInstantNanos(request.rangeStartAt)
    const end = intradayInstantNanos(request.rangeEndAt)
    const symbols = request.symbols ?? request.universe
    const source = state.sources.get(request.universeId)
    const technicalTopic = source?.topics.technicalFeatures
    const inputTopics = Object.values(source?.topics ?? request.sourceTopics)
    const observationEvicted =
      request.purpose === IntradaySnapshotPurpose.Liquidation
        ? symbols.some((symbol) => (state.minimumQuoteObservationMs.get(symbol) ?? 0) > observedAtMs)
        : state.minimumObservationMs > observedAtMs
    if (
      observationEvicted ||
      (request.purpose === IntradaySnapshotPurpose.Liquidation ? [request.sourceTopics.quotes] : inputTopics).some(
        (topic) => discardedRejectionsOverlap(state, Date.parse(request.rangeStartAt), topic),
      )
    )
      return yield* Result.fail(
        failure('not-ready', 'Streaming projection has no complete retained cut for this observation'),
      )
    const marketCloseAt = snapshotMarketCloseAt(request.calendar, request.sessionDate, request.observedAt)
    if (marketCloseAt === undefined)
      return yield* Result.fail(failure('request', 'Streaming snapshot has no bound exchange session'))
    const candidates = new Set(request.candidateSymbols)
    const entries: ObservedMarketValue<IntradayBar | IntradayQuote | IntradayTrade>[] = []
    const featureReceipts: StreamingFeatureReceipt[] = []
    const barPublications: ObservedMarketValue<IntradayBar>[] = []
    const publicationBars: IntradayBar[] = []
    const technicalReceipts: StreamingFeatureReceipt<TechnicalMarketFeature>[] = []
    const featureExclusions: IntradayCandidateExclusion[] = []
    const missingRangeCompletionBars = new Set<string>()
    for (const [key, history] of state.rejections) {
      if (
        ![
          ...Object.values(request.sourceTopics),
          ...[...state.features.values()]
            .flat()
            .filter((entry) => request.universe.includes(entry.value.material.symbol))
            .map((entry) => entry.topic),
        ].some((topic) => key.startsWith(`${topic}:`))
      )
        continue
      if (request.purpose === IntradaySnapshotPurpose.Liquidation && !key.startsWith(`${request.sourceTopics.quotes}:`))
        continue
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
      if (request.purpose === undefined) {
        entries.push(...bars)
        for (const bar of bars) {
          const publication = bar.firstPublication
          publicationBars.push((publication ?? bar).value)
          if (publication !== undefined) {
            if (publication.availableAtMs > observedAtMs || publication.sequence >= bar.sequence)
              return yield* Result.fail(failure('not-ready', 'Bar publication witness is outside the observed cut'))
            barPublications.push(publication)
          }
        }
      }
      if (quote !== undefined && intradayInstantNanos(quote.value.eventAt) >= start) entries.push(quote)
      if (request.purpose === undefined && trade !== undefined && intradayInstantNanos(trade.value.eventAt) >= start)
        entries.push(trade)
      if (request.purpose !== undefined) continue
      if (technicalTopic !== undefined) {
        for (const candidate of state.technicalFeatures.get(symbol) ?? []) {
          if (
            candidate.topic !== technicalTopic ||
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
          (!isCryptoMarketFeature(candidate.value) && candidate.value.material.sessionDate !== request.sessionDate) ||
          rollingWindowStartMs(candidate.value) !== Date.parse(request.rangeStartAt) ||
          candidate.value.material.windowEndMs !== Date.parse(request.rangeEndAt)
        )
          continue
        const matches = yield* nativeFeatureMatchesBars(
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
      if (
        request.benchmarkSymbols?.includes(symbol) === true &&
        (selected === undefined ||
          !bars.some((bar) => intradayInstantNanos(bar.value.eventAt) === end - 60_000_000_000n))
      )
        return yield* Result.fail(
          failure('not-ready', `Required completed-bar benchmark is unavailable for ${symbol}`, { symbol }),
        )
      if (selected !== undefined) featureReceipts.push(selected)
      else if (candidates.has(symbol)) {
        let message = 'matching complete rolling feature is unavailable'
        if (request.candidateEvidencePolicy === IntradayCandidateEvidencePolicy.QuoteWithWindowTrade) {
          const present = new Set(bars.map((bar) => intradayInstantNanos(bar.value.eventAt)))
          const missing = missingMinuteBars(
            bars.map((bar) => bar.value),
            request.rangeStartAt,
            request.rangeEndAt,
          )
          if (!present.has(end - 60_000_000_000n)) missingRangeCompletionBars.add(symbol)
          message =
            missing.length > 0
              ? `rolling window lacks ${missing.length} of ${Number((end - start) / 60_000_000_000n)} required minute bars: ${missing.join(', ')}`
              : 'no observed rolling feature matches the complete bar window'
        }
        featureExclusions.push({ symbol, reason: 'not-ready', message })
      } else
        return yield* Result.fail(
          new IntradaySnapshotFailure({
            reason: 'not-ready',
            message: `Required rolling feature is unavailable for ${symbol}`,
            facts: {
              symbol,
              eventAt: request.rangeEndAt,
              requiredFeature: {
                definitionId: MarketFeatureDefinition.ObservedPriceWindow,
                definitionHash: rollingFeatureDefinitionHash,
                windowStartAt: request.rangeStartAt,
                windowEndAt: request.rangeEndAt,
              },
            },
          }),
        )
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
      marketCloseAt,
      true,
      undefined,
      marketFeatureClockSkewAllowanceMs,
    )
    yield* validateBarStructure(request, bars, marketFeatureClockSkewAllowanceMs)
    yield* validateIdentity(
      request,
      barPublications.map((entry) => entry.value),
      request.rangeEndAt,
      false,
      undefined,
      marketFeatureClockSkewAllowanceMs,
    )
    yield* validateBarStructure(request, publicationBars, marketFeatureClockSkewAllowanceMs)
    const availability = yield* candidateAvailability(
      request,
      publicationBars,
      quotes,
      trades,
      marketFeatureClockSkewAllowanceMs,
    )
    const exclusions = new Map(availability.exclusions.map((exclusion) => [exclusion.symbol, exclusion]))
    for (const exclusion of featureExclusions) {
      const current = exclusions.get(exclusion.symbol)
      if (current === undefined || (current.reason === 'not-ready' && missingRangeCompletionBars.has(exclusion.symbol)))
        exclusions.set(exclusion.symbol, exclusion)
    }
    const excluded = new Set(exclusions.keys())
    const technicalFeatures =
      request.candidateEvidencePolicy === IntradayCandidateEvidencePolicy.QuoteWithWindowTrade
        ? technicalReceipts
        : technicalReceipts.filter((feature) => !excluded.has(feature.value.material.symbol))
    const technical =
      technicalTopic === undefined
        ? undefined
        : {
            topic: technicalTopic,
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
      barPublications,
      technical,
      bars,
      quotes,
      trades,
      availability,
      exclusions,
      excluded,
    }
  })

export const diagnoseStreamingInputs = (state: StreamingProjection, query: IntradaySnapshotQuery) =>
  Result.map(selectStreamingInputs(state, query), (selected) => {
    const observedAtMs = Date.parse(query.observedAt)
    const candidates = (query.candidateSymbols ?? []).map((symbol) => {
      const bars = observedBarsAt(
        state,
        symbol,
        intradayInstantNanos(query.rangeStartAt),
        intradayInstantNanos(query.rangeEndAt),
        observedAtMs,
      )
      const quote = state.quoteHistory.get(symbol)?.findLast((entry) => observedWithin(entry, observedAtMs))
      const exclusion = selected.exclusions.get(symbol)
      return {
        symbol,
        eligibility:
          exclusion === undefined
            ? { status: 'ELIGIBLE' as const }
            : { status: 'EXCLUDED' as const, reason: exclusion.reason, message: exclusion.message },
        window: {
          startAt: query.rangeStartAt,
          endAt: query.rangeEndAt,
          requiredBarCount: (Date.parse(query.rangeEndAt) - Date.parse(query.rangeStartAt)) / 60_000,
          observedBarCount: bars.length,
          missingBarAt: missingMinuteBars(
            bars.map((entry) => entry.value),
            query.rangeStartAt,
            query.rangeEndAt,
          ),
        },
        matchingFeature: selected.featureReceipts.find((entry) => entry.value.material.symbol === symbol) ?? null,
        quote:
          quote === undefined
            ? null
            : {
                eventAt: quote.value.eventAt,
                ageMs: observedAtMs - Date.parse(quote.value.eventAt),
                availableAtMs: quote.availableAtMs,
                sourceTopic: quote.value.sourceTopic,
                sourcePartition: quote.value.sourcePartition,
                sourceOffset: quote.value.sourceOffset,
              },
      }
    })
    return { observedAt: query.observedAt, candidates }
  })
