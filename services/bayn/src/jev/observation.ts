import { exchangeSessions } from '../market-hours'
import { jevMarketForFeed, jevBenchmarkSymbol } from './markets'
import { isContinuousMarket } from '../market-hours'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { freezeEvidence } from '../immutable-evidence'
import { maximumBrokerObservationAgeMs } from '../broker/alpaca/observed-snapshot'
import { intradayAgeNanos } from '../market-data/intraday/time'
import { strictParseOptions } from '../schemas'
import { reproduceStrategySnapshot } from '../market-data/streaming/replay'

import { IntradayBenchmarkEvidencePolicy } from '../market-data/intraday/model'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import {
  isOwnedMarketSnapshot,
  type StrategyMarketSnapshot,
  type VerifiedStrategyMarketSnapshot,
} from '../market-data/streaming/snapshot'
import { JevContractError } from './contract'
import { JevObservationSchema, RetainedJevObservationSchema } from './observation-contract'
import { JevObservationCheck, JevObservationField } from './observation-diagnostics'
import { decodeJevPortfolio, isOwnedJevPortfolio, jevPortfolioCandidates, type JevPortfolio } from './portfolio'
import type { JevProtocol } from './protocol'
import type { EquityShortEligibility } from '../execution/equity-short'
import { jevHistoryStartMs, jevSignalWindowEndMs } from './observation-query'

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

const verifyObservation = <
  Observation extends typeof JevObservationSchema.Type | typeof RetainedJevObservationSchema.Type,
>(
  observation: Observation,
  snapshot: StrategyMarketSnapshot,
) =>
  Result.gen(function* () {
    const candidates =
      observation.portfolio.purpose === 'ENTRY'
        ? []
        : jevPortfolioCandidates(observation.portfolio, observation.protocol.candidateSymbols)
    const market = jevMarketForFeed(
      snapshot.manifest.feed,
      observation.protocol.marketProfiles.find((profile) => profile.feed === snapshot.manifest.feed)?.universeId,
    )
    const requestedCandidates =
      observation.portfolio.purpose === 'ENTRY' ? (snapshot.manifest.candidateSymbols ?? []) : candidates
    const hasReference =
      snapshot.manifest.benchmarkEvidencePolicy !== undefined ||
      snapshot.manifest.symbols.some((symbol) => !requestedCandidates.includes(symbol))
    const benchmarks = hasReference ? [...new Set(requestedCandidates.map(jevBenchmarkSymbol))].sort() : []
    const symbols = [...new Set([...requestedCandidates, ...benchmarks])].sort()
    if (snapshot.manifest.observedAt !== observation.observedAt)
      return yield* Result.fail(invalidObservation(JevObservationCheck.ObservationTime))
    if (
      [...snapshot.bars, ...snapshot.quotes, ...snapshot.trades].some(
        (record) =>
          intradayAgeNanos(observation.observedAt, record.eventAt) < 0n ||
          intradayAgeNanos(observation.observedAt, record.ingestedAt) < 0n,
      )
    )
      return yield* Result.fail(invalidObservation(JevObservationCheck.Snapshot))
    if (
      snapshot.manifest.candidateSymbols?.join('|') !== requestedCandidates.join('|') ||
      requestedCandidates.length === 0 ||
      requestedCandidates.some((symbol) => !snapshot.manifest.symbols.includes(symbol))
    )
      return yield* Result.fail(invalidObservation(JevObservationCheck.Candidates))
    if (observation.schemaVersion === 'bayn.jev-observation.v1') {
      const { protocol, portfolio } = observation
      const manifest = snapshot.manifest
      const observed = Date.parse(observation.observedAt)
      const end = jevSignalWindowEndMs(observed, protocol)
      const session = isContinuousMarket(manifest.calendar)
        ? undefined
        : exchangeSessions(manifest.calendar).find((entry) => entry.date === manifest.sessionDate)
      const state = portfolio.brokerState
      if (
        manifest.universeId !== market.universeId ||
        manifest.universeSymbolHash !== market.universeSymbolHash ||
        manifest.universe?.join('|') !== market.universe.join('|') ||
        manifest.symbols.join('|') !== symbols.join('|') ||
        requestedCandidates.some((symbol) => !protocol.candidateSymbols.includes(symbol))
      )
        return yield* Result.fail(invalidObservation(JevObservationCheck.Universe))
      if (
        manifest.feed !== market.feed ||
        manifest.delayClass !== market.delayClass ||
        manifest.maximumQuoteAgeMs !== protocol.maximumQuoteAgeMs ||
        manifest.candidateEvidencePolicy !== protocol.candidateEvidencePolicy ||
        manifest.benchmarkEvidencePolicy !==
          (hasReference && 'benchmarkEvidencePolicy' in market ? market.benchmarkEvidencePolicy : undefined) ||
        manifest.benchmarkSymbols?.join('|') !==
          (hasReference && 'benchmarkEvidencePolicy' in market ? benchmarks.join('|') : undefined)
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
          jevHistoryStartMs(
            manifest.calendar,
            manifest.sessionDate,
            end,
            isContinuousMarket(manifest.calendar) ? protocol.lookbackMinutes.crypto : protocol.lookbackMinutes.equity,
          )
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

const reproduceObservation = <
  Observation extends typeof JevObservationSchema.Type | typeof RetainedJevObservationSchema.Type,
>(
  observation: Observation,
) =>
  reproduceStrategySnapshot(observation.manifest, observation.rows).pipe(
    Result.mapError((cause) => invalidObservation(JevObservationCheck.Snapshot, cause)),
    Result.flatMap((snapshot) => verifyObservation(observation, snapshot)),
  )

export const reproduceJevCandidateObservation = (input: unknown) =>
  Schema.decodeUnknownResult(
    JevObservationSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => invalidObservation(JevObservationCheck.Schema, cause)),
    Result.flatMap(reproduceObservation),
  )

// Financial evidence reader only; current observation and execution admission remain strict.
export const reproduceRetainedJevCandidateObservation = (input: unknown) =>
  Schema.decodeUnknownResult(
    RetainedJevObservationSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError((cause) => invalidObservation(JevObservationCheck.Schema, cause)),
    Result.flatMap(reproduceObservation),
  )

const OwnedObservationTypeId: unique symbol = Symbol('OwnedJevObservation')

export interface OwnedJevObservation {
  readonly [OwnedObservationTypeId]: true
  readonly payload: JevObservation
  readonly verified: Result.Result.Success<ReturnType<typeof reproduceJevCandidateObservation>>
}

const ownedObservations = new WeakSet<OwnedJevObservation>()

const sealObservation = (payload: JevObservation, verified: OwnedJevObservation['verified']) =>
  Result.gen(function* () {
    if ((yield* canonicalHashV1Result(payload)) !== verified.contentHash)
      return yield* Result.fail(invalidObservation(JevObservationCheck.Identity))
    const source: OwnedJevObservation = freezeEvidence({
      [OwnedObservationTypeId]: true,
      payload,
      verified,
    })
    ownedObservations.add(source)
    return source
  })

const detachObservation = <A>(input: A) =>
  Result.try({
    try: () => structuredClone(input),
    catch: (cause) => invalidObservation(JevObservationCheck.Identity, cause),
  })

export const ownJevObservation = (input: JevObservation) =>
  Result.gen(function* () {
    const payload = yield* detachObservation(input)
    const verified = yield* reproduceJevCandidateObservation(payload)
    return yield* sealObservation(payload, verified)
  })

export const isOwnedJevObservation = (observation: OwnedJevObservation) => ownedObservations.has(observation)

const jevObservationPayload = (input: {
  readonly cycleId: string
  readonly authorityGenerationHash: string
  readonly protocol: JevProtocol
  readonly portfolio: JevPortfolio
  readonly snapshot: VerifiedStrategyMarketSnapshot
  readonly equityShortEligibility?: Readonly<Record<string, EquityShortEligibility>>
}) =>
  Result.gen(function* () {
    const rows = yield* persistIntradayRecordRows(input.snapshot)
    return {
      schemaVersion: 'bayn.jev-observation.v1' as const,
      cycleId: input.cycleId,
      authorityGenerationHash: input.authorityGenerationHash,
      observedAt: input.snapshot.manifest.observedAt,
      protocol: input.protocol,
      portfolio: input.portfolio,
      ...(input.equityShortEligibility === undefined ? {} : { equityShortEligibility: input.equityShortEligibility }),
      manifest: input.snapshot.manifest,
      rows,
    }
  })

export type JevObservation = Result.Result.Success<ReturnType<typeof jevObservationPayload>>

export const makeJevObservation = (input: Parameters<typeof jevObservationPayload>[0]) =>
  jevObservationPayload(input).pipe(
    Result.flatMap((payload) =>
      Result.map(reproduceJevCandidateObservation(payload), ({ contentHash }) => ({ contentHash, payload })),
    ),
  )

const decodeObservationEnvelope = Schema.decodeUnknownResult(
  Schema.Struct({ ...JevObservationSchema.fields, portfolio: Schema.Unknown }),
  strictParseOptions,
)

export const makeOwnedJevObservation = (input: Parameters<typeof jevObservationPayload>[0]) =>
  Result.gen(function* () {
    const { snapshot, portfolio: suppliedPortfolio, ...context } = input
    if (!isOwnedMarketSnapshot(snapshot)) return yield* Result.fail(invalidObservation(JevObservationCheck.Snapshot))
    const portfolio = isOwnedJevPortfolio(suppliedPortfolio)
      ? suppliedPortfolio
      : yield* decodeJevPortfolio(suppliedPortfolio).pipe(
          Result.mapError((cause) => invalidObservation(JevObservationCheck.Schema, cause)),
        )
    const {
      portfolio: _portfolio,
      manifest,
      ...observation
    } = yield* jevObservationPayload({
      ...context,
      snapshot,
      portfolio,
    })
    const detached = yield* detachObservation(observation)
    const payload = { ...detached, manifest, portfolio }
    const decoded = yield* decodeObservationEnvelope(payload).pipe(
      Result.mapError((cause) => invalidObservation(JevObservationCheck.Schema, cause)),
    )
    const verified = yield* verifyObservation({ ...decoded, portfolio }, snapshot)
    return yield* sealObservation(payload, verified)
  })

/** Restore the current typed graph while retaining the exact admitted source identity. */
export const restoreVerifiedJevObservation = ({
  snapshot,
  contentHash,
  ...source
}: Result.Result.Success<ReturnType<typeof reproduceJevCandidateObservation>>) =>
  Result.gen(function* () {
    const observation: JevObservation = {
      ...source,
      manifest: snapshot.manifest,
      rows: yield* persistIntradayRecordRows(snapshot),
    }
    if ((yield* canonicalHashV1Result(observation)) !== contentHash)
      return yield* Result.fail(invalidObservation(JevObservationCheck.Identity))
    return { observation, snapshot, contentHash }
  })

export const restoreJevObservation = (input: unknown) =>
  reproduceJevCandidateObservation(input).pipe(Result.flatMap(restoreVerifiedJevObservation))

export type RestoredJevObservation = Result.Result.Success<ReturnType<typeof restoreJevObservation>>
