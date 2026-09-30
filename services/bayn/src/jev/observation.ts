import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { reproduceStrategySnapshot } from '../market-data/streaming/replay'
import { IntradayMomentumProtocolSchema } from '../strategy/intraday-momentum/protocol'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import type { VerifiedStrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import { JevContractError } from './contract'
import { JevObservationSchema } from './observation-contract'
import { JevObservationCheck, JevObservationField } from './observation-diagnostics'
import { jevPortfolioCandidates, type JevPortfolio } from './portfolio'
import type { JevProtocol } from './protocol'

const HistoricalObservationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-candidate-observation.v2'),
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  protocol: IntradayMomentumProtocolSchema,
  manifest: Schema.Record(Schema.String, Schema.Unknown),
  rows: Schema.Struct({
    bars: Schema.Array(Schema.Unknown),
    quotes: Schema.Array(Schema.Unknown),
    trades: Schema.Array(Schema.Unknown),
  }),
  decision: Schema.Unknown,
})

const ObservationSchema = Schema.Union([HistoricalObservationSchema, JevObservationSchema])

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
      ObservationSchema,
      strictParseOptions,
    )(input).pipe(Result.mapError((cause) => invalidObservation(JevObservationCheck.Schema, cause)))
    const candidates =
      observation.schemaVersion === 'bayn.jev-observation.v1'
        ? jevPortfolioCandidates(observation.portfolio, observation.protocol.candidateSymbols)
        : observation.protocol.candidateSymbols
    const snapshot = yield* reproduceStrategySnapshot(observation.manifest, observation.rows).pipe(
      Result.mapError((cause) => invalidObservation(JevObservationCheck.Snapshot, cause)),
    )
    if (snapshot.manifest.observedAt !== observation.observedAt)
      return yield* Result.fail(invalidObservation(JevObservationCheck.ObservationTime))
    if (
      snapshot.manifest.candidateSymbols?.join('|') !== candidates.join('|') ||
      !snapshot.manifest.symbols.includes(observation.protocol.benchmarkSymbol)
    )
      return yield* Result.fail(invalidObservation(JevObservationCheck.Candidates))
    if (observation.schemaVersion === 'bayn.jev-observation.v1') {
      const { protocol, portfolio } = observation
      const manifest = snapshot.manifest
      const observed = Date.parse(observation.observedAt)
      const end = Math.floor((observed - protocol.decisionDelaySeconds * 1000) / 60_000) * 60_000
      const session = manifest.calendar.sessions.find((entry) => entry.date === manifest.sessionDate)
      const state = portfolio.brokerState
      if (
        manifest.universeId !== protocol.universeId ||
        manifest.universeSymbolHash !== protocol.universeSymbolHash ||
        manifest.universe?.join('|') !== protocol.universe.join('|') ||
        manifest.symbols.join('|') !== [...candidates, protocol.benchmarkSymbol].sort().join('|') ||
        candidates.some((symbol) => !protocol.candidateSymbols.includes(symbol))
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Universe))
      if (
        manifest.feed !== protocol.feed ||
        manifest.delayClass !== protocol.delayClass ||
        manifest.maximumQuoteAgeMs !== protocol.maximumQuoteAgeMs ||
        manifest.candidateEvidencePolicy !== protocol.candidateEvidencePolicy
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Feed))
      if (
        manifest.sourceTopics.bars !== protocol.sourceTopics.bars ||
        manifest.sourceTopics.quotes !== protocol.sourceTopics.quotes ||
        manifest.sourceTopics.trades !== protocol.sourceTopics.trades
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Topics))
      if (
        Date.parse(manifest.rangeEndAt) !== end ||
        Date.parse(manifest.rangeStartAt) !== end - protocol.lookbackMinutes * 60_000
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Window))
      if (observed - end - protocol.decisionDelaySeconds * 1000 > protocol.maximumDecisionLagMs)
        return yield* Result.fail(invalidObservation(JevObservationCheck.DecisionLag))
      if (
        session === undefined ||
        Date.parse(manifest.rangeStartAt) < Date.parse(session.openAt) ||
        observed >= Date.parse(session.closeAt) - protocol.entryCutoffMinutesBeforeClose * 60_000
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
        if (observed - Date.parse(at) > protocol.maximumQuoteAgeMs)
          return yield* Result.fail(invalidObservation(JevObservationCheck.PortfolioStale, undefined, field))
      }
      if (
        manifest.streaming.features.some(
          ({ topic, value }) =>
            topic !== protocol.streamingInput.featureTopic ||
            value.material.definitionId !== protocol.streamingInput.requiredDefinitionId ||
            value.material.definitionHash !== protocol.streamingInput.requiredDefinitionHash,
        )
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Features))
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
