import { BarPublicationPolicy } from '../intraday/bar-publication'
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
  featureMatchesBars,
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

/** Shared input policy only. This does not issue live snapshot or broker authority. */
export const selectStreamingInputs = (
  state: StreamingProjection,
  query: IntradaySnapshotQuery,
  publicationPolicy = BarPublicationPolicy.TimelyEquivalentRevision,
) =>
  Result.gen(function* () {
    const request = yield* verifyIntradaySnapshotQuery(query)
    const observedAtMs = Date.parse(request.observedAt)
    const start = intradayInstantNanos(request.rangeStartAt)
    const end = intradayInstantNanos(request.rangeEndAt)
    const symbols = request.symbols ?? request.universe
    const observationEvicted =
      request.purpose === IntradaySnapshotPurpose.Liquidation
        ? symbols.some((symbol) => (state.minimumQuoteObservationMs.get(symbol) ?? 0) > observedAtMs)
        : state.minimumObservationMs > observedAtMs
    if (
      observationEvicted ||
      discardedRejectionsOverlap(
        state,
        Date.parse(request.rangeStartAt),
        request.purpose === IntradaySnapshotPurpose.Liquidation ? request.sourceTopics.quotes : undefined,
      )
    )
      return yield* Result.fail(
        failure('not-ready', 'Streaming projection has no complete retained cut for this observation'),
      )
    const session = request.calendar.sessions.find((entry) => entry.date === request.sessionDate)
    if (session === undefined)
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
          const publication =
            publicationPolicy === BarPublicationPolicy.TimelyEquivalentRevision ? bar.firstPublication : undefined
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
      else if (candidates.has(symbol)) {
        let message = 'matching complete rolling feature is unavailable'
        if (request.candidateEvidencePolicy === IntradayCandidateEvidencePolicy.QuoteWithWindowTrade) {
          const present = new Set(bars.map((bar) => intradayInstantNanos(bar.value.eventAt)))
          const missing: string[] = []
          for (let at = start; at < end; at += 60_000_000_000n)
            if (!present.has(at)) missing.push(new Date(Number(at / 1_000_000n)).toISOString())
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
                definitionId: MarketFeatureDefinition.RollingPrice30m,
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
      session.closeAt,
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
      publicationPolicy,
    )
    const exclusions = new Map(availability.exclusions.map((exclusion) => [exclusion.symbol, exclusion]))
    for (const exclusion of featureExclusions) {
      const current = exclusions.get(exclusion.symbol)
      if (current === undefined || (current.reason === 'not-ready' && missingRangeCompletionBars.has(exclusion.symbol)))
        exclusions.set(exclusion.symbol, exclusion)
    }
    const excluded = new Set(exclusions.keys())
    if (request.purpose === undefined && candidates.size > 0 && [...candidates].every((symbol) => excluded.has(symbol)))
      return yield* Result.fail(
        failure('not-ready', 'No candidate has complete raw data and a matching rolling feature'),
      )
    const technicalFeatures =
      request.candidateEvidencePolicy === IntradayCandidateEvidencePolicy.QuoteWithWindowTrade
        ? technicalReceipts
        : technicalReceipts.filter((feature) => !excluded.has(feature.value.material.symbol))
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
