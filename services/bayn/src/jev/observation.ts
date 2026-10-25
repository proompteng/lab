import { exchangeSessions } from '../market-hours'
import { jevMarketForFeed, jevBenchmarkSymbol } from './markets'
import { isContinuousMarket } from '../market-hours'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { maximumBrokerObservationAgeMs } from '../broker/alpaca/observed-snapshot'
import { strictParseOptions } from '../schemas'
import { reproduceStrategySnapshot } from '../market-data/streaming/replay'

import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { IntradayBenchmarkEvidencePolicy } from '../market-data/intraday/model'
import type { VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { JevContractError } from './contract'
import { JevObservationSchema } from './observation-contract'
import { JevObservationCheck, JevObservationField } from './observation-diagnostics'
import { jevPortfolioCandidates, type JevPortfolio } from './portfolio'
import type { JevProtocol } from './protocol'
import { jevHistoryStartMs } from './observation-query'

const invalidObservation = (
  observationCheck: JevObservationCheck,
  cause?: unknown,
  observationField?: JevObservationField,
) =>
  new JevContractError({
    message: `Jev candidate observation cannot be reproduced [${observationCheck}${observationField === undefined ? '' : `:${observationField}`}]`,
    observationCheck,
    ...(observationField === undefined ? {} : { observationField }),
    ...(cause === undefined ? {} : { cause }),
  })

export const reproduceJevCandidateObservation = (input: unknown) =>
  Result.gen(function* () {
    const observation = yield* Schema.decodeUnknownResult(
      JevObservationSchema,
      strictParseOptions,
    )(input).pipe(Result.mapError((cause) => invalidObservation(JevObservationCheck.Schema, cause)))
    const candidates =
      observation.portfolio.purpose === 'ENTRY'
        ? []
        : jevPortfolioCandidates(observation.portfolio, observation.protocol.candidateSymbols)
    const snapshot = yield* reproduceStrategySnapshot(observation.manifest, observation.rows).pipe(
      Result.mapError((cause) => invalidObservation(JevObservationCheck.Snapshot, cause)),
    )
    const market = jevMarketForFeed(snapshot.manifest.feed)
    const requestedCandidates =
      observation.portfolio.purpose === 'ENTRY' ? (snapshot.manifest.candidateSymbols ?? []) : candidates
    if (snapshot.manifest.observedAt !== observation.observedAt)
      return yield* Result.fail(invalidObservation(JevObservationCheck.ObservationTime))
    if (
      snapshot.manifest.candidateSymbols?.join('|') !== requestedCandidates.join('|') ||
      requestedCandidates.length === 0 ||
      requestedCandidates.some((symbol) => !snapshot.manifest.symbols.includes(jevBenchmarkSymbol(symbol)))
    )
      return yield* Result.fail(invalidObservation(JevObservationCheck.Candidates))
    if (observation.schemaVersion === 'bayn.jev-observation.v1') {
      const { protocol, portfolio } = observation
      const manifest = snapshot.manifest
      const observed = Date.parse(observation.observedAt)
      const end = Math.floor((observed - protocol.decisionDelaySeconds * 1000) / 60_000) * 60_000
      const session = isContinuousMarket(manifest.calendar)
        ? undefined
        : exchangeSessions(manifest.calendar).find((entry) => entry.date === manifest.sessionDate)
      const state = portfolio.brokerState
      if (
        manifest.universeId !== market.universeId ||
        manifest.universeSymbolHash !== market.universeSymbolHash ||
        manifest.universe?.join('|') !== market.universe.join('|') ||
        manifest.symbols.join('|') !==
          [...new Set([...requestedCandidates, ...requestedCandidates.map(jevBenchmarkSymbol)])].sort().join('|') ||
        requestedCandidates.some((symbol) => !protocol.candidateSymbols.includes(symbol))
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Universe))
      if (
        manifest.feed !== market.feed ||
        manifest.delayClass !== market.delayClass ||
        manifest.maximumQuoteAgeMs !== protocol.maximumQuoteAgeMs ||
        manifest.candidateEvidencePolicy !== protocol.candidateEvidencePolicy ||
        manifest.benchmarkEvidencePolicy !==
          ('benchmarkEvidencePolicy' in market ? market.benchmarkEvidencePolicy : undefined)
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Feed))
      if (
        manifest.sourceTopics.bars !== market.sourceTopics.bars ||
        manifest.sourceTopics.quotes !== market.sourceTopics.quotes ||
        manifest.sourceTopics.trades !== market.sourceTopics.trades
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Topics))
      if (
        Date.parse(manifest.rangeEndAt) !== end ||
        Date.parse(manifest.rangeStartAt) !==
          jevHistoryStartMs(manifest.calendar, manifest.sessionDate, end, protocol.lookbackMinutes)
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Window))
      if (observed - end - protocol.decisionDelaySeconds * 1000 > protocol.maximumDecisionLagMs)
        return yield* Result.fail(invalidObservation(JevObservationCheck.DecisionLag))
      if (
        !isContinuousMarket(manifest.calendar) &&
        (session === undefined ||
          Date.parse(manifest.rangeStartAt) < Date.parse(session.openAt) ||
          observed >= Date.parse(session.closeAt) - protocol.entryCutoffMinutesBeforeClose * 60_000)
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Session))
      const brokerTimes = [
        [JevObservationField.Account, state.account.observedAt],
        [JevObservationField.Positions, state.positionsObservedAt],
        [JevObservationField.Orders, state.ordersObservedAt],
        [JevObservationField.Reconciliation, state.reconciliation.reconciledAt],
      ] as const
      for (const [field, at] of brokerTimes) {
        if (Date.parse(at) > observed)
          return yield* Result.fail(invalidObservation(JevObservationCheck.PortfolioPremature, undefined, field))
        if (observed - Date.parse(at) >= maximumBrokerObservationAgeMs)
          return yield* Result.fail(invalidObservation(JevObservationCheck.PortfolioStale, undefined, field))
      }
      if (
        manifest.streaming.features.some(
          ({ topic, value }) =>
            topic !== market.streamingInput.featureTopic ||
            value.material.definitionId !== market.streamingInput.requiredDefinitionId ||
            value.material.definitionHash !== market.streamingInput.requiredDefinitionHash,
        )
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Features))
      if (manifest.benchmarkEvidencePolicy === IntradayBenchmarkEvidencePolicy.CompletedBars) {
        if (
          manifest.benchmarkSymbols?.join('|') !==
          [...new Set(requestedCandidates.map(jevBenchmarkSymbol))].sort().join('|')
        )
          return yield* Result.fail(invalidObservation(JevObservationCheck.Candidates))
        for (const symbol of new Set(requestedCandidates.map(jevBenchmarkSymbol))) {
          if (
            !manifest.streaming.features.some((feature) => feature.value.material.symbol === symbol) ||
            !snapshot.bars.some((bar) => bar.symbol === symbol && Date.parse(bar.eventAt) === end - 60_000)
          )
            return yield* Result.fail(invalidObservation(JevObservationCheck.Features, { requiredBenchmark: symbol }))
        }
      }
    }
    return { ...observation, snapshot, contentHash: yield* canonicalHashV1Result(observation) }
  }).pipe(
    Result.mapError((cause) =>
      cause instanceof JevContractError && cause.observationCheck !== undefined
        ? cause
        : invalidObservation(JevObservationCheck.Identity, cause),
    ),
  )

export const makeJevObservation = (input: {
  readonly cycleId: string
  readonly authorityGenerationHash: string
  readonly protocol: JevProtocol
  readonly portfolio: JevPortfolio
  readonly snapshot: VerifiedStrategyMarketSnapshot
}) =>
  Result.gen(function* () {
    const rows = yield* persistIntradayRecordRows(input.snapshot)
    const payload = {
      schemaVersion: 'bayn.jev-observation.v1' as const,
      cycleId: input.cycleId,
      authorityGenerationHash: input.authorityGenerationHash,
      observedAt: input.snapshot.manifest.observedAt,
      protocol: input.protocol,
      portfolio: input.portfolio,
      manifest: input.snapshot.manifest,
      rows,
    }
    const reproduced = yield* reproduceJevCandidateObservation(payload)
    return { contentHash: reproduced.contentHash, payload }
  })

export type JevObservation = Result.Result.Success<ReturnType<typeof makeJevObservation>>['payload']
