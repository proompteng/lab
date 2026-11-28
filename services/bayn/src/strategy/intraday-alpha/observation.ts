import { Result, Schema } from 'effect'

import { maximumBrokerObservationAgeMs } from '../../broker/alpaca/observed-snapshot'
import { EquityShortEligibilitySchema } from '../../execution/equity-short'
import { canonicalHashV1Result } from '../../hash'
import { freezeEvidence } from '../../immutable-evidence'
import { JevContractError } from '../../jev/contract'
import { JevObservationSchema } from '../../jev/observation-contract'
import { jevSignalWindowEndMs } from '../../jev/observation-query'
import {
  decodeJevPortfolio,
  isOwnedJevPortfolio,
  JevPortfolioSchema,
  JevPurpose,
  type JevPortfolio,
} from '../../jev/portfolio'
import { JevProtocolSchema, type JevProtocol } from '../../jev/protocol'
import { IntradayBenchmarkEvidencePolicy, IntradayCandidateEvidencePolicy } from '../../market-data/intraday/model'
import { intradayAgeNanos, millisecondsAsNanos } from '../../market-data/intraday/time'
import {
  IntradayAlphaTrailingBaselineSchema,
  type IntradayAlphaTrailingBaseline,
} from '../../market-data/intraday/trailing-baseline'
import { persistIntradayRecordRows } from '../../market-data/intraday/verification'
import { reproduceStrategySnapshot } from '../../market-data/streaming/replay'
import {
  isOwnedMarketSnapshot,
  type StrategyMarketSnapshot,
  type VerifiedStrategyMarketSnapshot,
} from '../../market-data/streaming/snapshot'
import { Sha256Schema, SymbolSchema, UtcInstantSchema, strictParseOptions } from '../../schemas'
import {
  intradayAlphaBenchmarkSymbol,
  intradayAlphaCandidateSymbols,
  intradayAlphaNoiseAreaSymbols,
  intradayAlphaEquityMarketProfile,
} from './policy'
import { resolveAlphaRegularSession } from './signals'

export const IntradayAlphaObservationSchema = Schema.Struct({
  schemaVersion: Schema.Literals(['bayn.intraday-alpha-observation.v2', 'bayn.intraday-alpha-observation.v3']),
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  protocol: JevProtocolSchema,
  portfolio: JevPortfolioSchema,
  trailingBaseline: IntradayAlphaTrailingBaselineSchema,
  equityShortEligibility: Schema.optionalKey(Schema.Record(SymbolSchema, EquityShortEligibilitySchema)),
  manifest: JevObservationSchema.fields.manifest,
  rows: JevObservationSchema.fields.rows,
})
export type IntradayAlphaObservation = typeof IntradayAlphaObservationSchema.Type
export const isIntradayAlphaObservation = (payload: {
  readonly schemaVersion: string
}): payload is IntradayAlphaObservation =>
  payload.schemaVersion === 'bayn.intraday-alpha-observation.v2' ||
  payload.schemaVersion === 'bayn.intraday-alpha-observation.v3'

const fail = (message: string, cause?: unknown) =>
  Result.fail(new JevContractError({ message, ...(cause === undefined ? {} : { cause }) }))

const verifyAlphaObservation = (observation: IntradayAlphaObservation, snapshot: StrategyMarketSnapshot) =>
  Result.gen(function* () {
    const { protocol, portfolio, trailingBaseline } = observation
    const manifest = snapshot.manifest
    const market = intradayAlphaEquityMarketProfile
    if (portfolio.purpose !== JevPurpose.Entry)
      return yield* fail('Intraday alpha observation requires ENTRY portfolio state')
    if (manifest.observedAt !== observation.observedAt)
      return yield* fail('Intraday alpha observation timestamp differs from snapshot manifest')
    if (
      trailingBaseline.sessionDate !== manifest.sessionDate ||
      trailingBaseline.latestPriorSessionDate >= manifest.sessionDate
    )
      return yield* fail('Intraday alpha trailing baseline must strictly precede and bind this session date')
    if (
      [...snapshot.bars, ...snapshot.quotes, ...snapshot.trades].some(
        (record) =>
          intradayAgeNanos(observation.observedAt, record.eventAt) < 0n ||
          intradayAgeNanos(observation.observedAt, record.ingestedAt) < 0n,
      )
    )
      return yield* fail('Intraday alpha snapshot contains future-dated market records')
    const regularSession = yield* resolveAlphaRegularSession(manifest.calendar, manifest.sessionDate)
    const observed = Date.parse(observation.observedAt)
    const end = jevSignalWindowEndMs(observed, protocol)
    const pureEtf = observation.schemaVersion === 'bayn.intraday-alpha-observation.v3'
    const publications = manifest.streaming.barPublications ?? []
    if (
      pureEtf &&
      (publications.some(({ row }) => intradayAgeNanos(row.ingested_at, row.event_at) < millisecondsAsNanos(60_000)) ||
        snapshot.bars.some(
          (bar) =>
            intradayAgeNanos(bar.ingestedAt, bar.eventAt) < millisecondsAsNanos(60_000) ||
            intradayAgeNanos(manifest.rangeEndAt, bar.eventAt) < millisecondsAsNanos(60_000),
        ))
    )
      return yield* fail('Pure ETF observation contains premature completed-bar evidence')
    const ordered = (
      rows: readonly unknown[],
      records: readonly {
        readonly sourceTopic: string
        readonly sourcePartition: number
        readonly sourceOffset: string
      }[],
    ) =>
      rows.length === records.length &&
      rows.every((row, index) => {
        const record = records[index]
        return (
          record !== undefined &&
          typeof row === 'object' &&
          row !== null &&
          'source_topic' in row &&
          'source_offset' in row &&
          'source_partition' in row &&
          record.sourceTopic === row.source_topic &&
          record.sourcePartition === Number(row.source_partition) &&
          record.sourceOffset === row.source_offset
        )
      })
    if (
      pureEtf &&
      (!ordered(observation.rows.bars, snapshot.bars) ||
        !ordered(observation.rows.quotes, snapshot.quotes) ||
        !ordered(observation.rows.trades, snapshot.trades))
    )
      return yield* fail('Pure ETF observation rows must match the canonical market cut order')
    const expectedCandidates = pureEtf ? intradayAlphaNoiseAreaSymbols : intradayAlphaCandidateSymbols
    if (
      pureEtf &&
      (trailingBaseline.lookbackSessions !== 14 ||
        Object.keys(trailingBaseline.symbols).some(
          (symbol) => !expectedCandidates.some((candidate) => symbol === candidate),
        ))
    )
      return yield* fail('Pure ETF baseline must bind the 14-session QQQ/SMH evidence')
    const expectedSymbols = [...new Set([...expectedCandidates, intradayAlphaBenchmarkSymbol])].sort()
    if (
      manifest.universeId !== market.universeId ||
      manifest.universeSymbolHash !== market.universeSymbolHash ||
      manifest.universe?.join('|') !== market.universe.join('|') ||
      manifest.candidateSymbols?.join('|') !== expectedCandidates.join('|') ||
      manifest.symbols.join('|') !== expectedSymbols.join('|') ||
      manifest.benchmarkSymbols?.join('|') !== intradayAlphaBenchmarkSymbol ||
      manifest.benchmarkEvidencePolicy !== IntradayBenchmarkEvidencePolicy.CompletedBars ||
      manifest.candidateEvidencePolicy !== IntradayCandidateEvidencePolicy.MarketQuotesV2 ||
      manifest.feed !== market.feed ||
      manifest.delayClass !== market.delayClass ||
      manifest.maximumQuoteAgeMs !== protocol.maximumQuoteAgeMs ||
      manifest.sourceTopics.bars !== market.sourceTopics.bars ||
      manifest.sourceTopics.quotes !== market.sourceTopics.quotes ||
      manifest.sourceTopics.trades !== market.sourceTopics.trades
    )
      return yield* fail('Intraday alpha snapshot manifest violates its bound SPY-benchmarked contract')
    if (Date.parse(manifest.rangeEndAt) !== end || manifest.rangeStartAt !== regularSession.openAt)
      return yield* fail('Intraday alpha snapshot must span from regular session open to the latest completed minute')
    if (observed - end - protocol.decisionDelaySeconds * 1000 > protocol.maximumDecisionLagMs)
      return yield* fail('Intraday alpha observation exceeds its decision lag bound')
    if (observed >= regularSession.closeMs - protocol.entryCutoffMinutesBeforeClose * 60_000)
      return yield* fail('Intraday alpha observation is past its entry cutoff')
    const state = portfolio.brokerState
    for (const at of [
      state.account.observedAt,
      state.positionsObservedAt,
      state.ordersObservedAt,
      state.reconciliation.reconciledAt,
    ]) {
      if (Date.parse(at) > observed || observed - Date.parse(at) >= maximumBrokerObservationAgeMs)
        return yield* fail('Intraday alpha broker portfolio state is premature or stale')
    }
    if (
      manifest.streaming.features.some(
        ({ topic, value }) =>
          topic !== market.streamingInput.featureTopic ||
          value.material.definitionId !== market.streamingInput.requiredDefinitionId ||
          value.material.definitionHash !== market.streamingInput.requiredDefinitionHash,
      )
    )
      return yield* fail('Intraday alpha streaming feature receipts violate the reviewed feature definition')
    if (
      !manifest.streaming.features.some((feature) => feature.value.material.symbol === intradayAlphaBenchmarkSymbol) ||
      !snapshot.bars.some(
        (bar) => bar.symbol === intradayAlphaBenchmarkSymbol && Date.parse(bar.eventAt) === end - 60_000,
      )
    )
      return yield* fail('Intraday alpha requires completed SPY benchmark bar and rolling feature')
    return { ...observation, snapshot, contentHash: yield* canonicalHashV1Result(observation) }
  })

export const reproduceIntradayAlphaObservation = (input: unknown) =>
  Schema.decodeUnknownResult(
    IntradayAlphaObservationSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError(
      (cause) => new JevContractError({ message: 'Intraday alpha observation schema is invalid', cause }),
    ),
    Result.flatMap((observation) =>
      reproduceStrategySnapshot(observation.manifest, observation.rows).pipe(
        Result.mapError(
          (cause) => new JevContractError({ message: 'Intraday alpha snapshot did not reproduce', cause }),
        ),
        Result.flatMap((snapshot) => verifyAlphaObservation(observation, snapshot)),
      ),
    ),
  )

export const makeOwnedIntradayAlphaObservation = (input: {
  readonly schemaVersion?: IntradayAlphaObservation['schemaVersion']
  readonly cycleId: string
  readonly authorityGenerationHash: string
  readonly protocol: JevProtocol
  readonly portfolio: JevPortfolio
  readonly trailingBaseline: IntradayAlphaTrailingBaseline
  readonly snapshot: VerifiedStrategyMarketSnapshot
  readonly equityShortEligibility?: Readonly<Record<string, typeof EquityShortEligibilitySchema.Type>>
}) =>
  Result.gen(function* () {
    if (!isOwnedMarketSnapshot(input.snapshot))
      return yield* fail('Intraday alpha observation requires an independently verified market snapshot')
    const portfolio = isOwnedJevPortfolio(input.portfolio)
      ? input.portfolio
      : yield* decodeJevPortfolio(input.portfolio)
    const rows = yield* persistIntradayRecordRows(input.snapshot).pipe(
      Result.mapError(
        (cause) => new JevContractError({ message: 'Intraday alpha rows could not be persisted', cause }),
      ),
    )
    const manifest = yield* Schema.decodeUnknownResult(JevObservationSchema.fields.manifest)(
      input.snapshot.manifest,
    ).pipe(
      Result.mapError(
        (cause) => new JevContractError({ message: 'Intraday alpha snapshot manifest is not serializable', cause }),
      ),
    )
    const payload: IntradayAlphaObservation = freezeEvidence({
      schemaVersion: input.schemaVersion ?? 'bayn.intraday-alpha-observation.v2',
      cycleId: input.cycleId,
      authorityGenerationHash: input.authorityGenerationHash,
      observedAt: input.snapshot.manifest.observedAt,
      protocol: input.protocol,
      portfolio,
      trailingBaseline: input.trailingBaseline,
      ...(input.equityShortEligibility === undefined ? {} : { equityShortEligibility: input.equityShortEligibility }),
      manifest,
      rows,
    })
    const verified = yield* verifyAlphaObservation(payload, input.snapshot)
    return { payload, contentHash: verified.contentHash, verified }
  })
