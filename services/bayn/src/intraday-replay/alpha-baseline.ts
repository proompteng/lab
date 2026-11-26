import { Effect, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { operationalError, retryableOperationalError, type OperationalError } from '../errors'
import type { IntradayTrailingBaselineService, TrailingBaselineQuery } from '../market-data/intraday/trailing-baseline'
import { strictParseOptions } from '../schemas'
import { reproduceIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import { intradayAlphaEquityMarketProfile } from '../strategy/intraday-alpha/policy'
import { ResearchStrategyEngine, type ResearchStrategyBinding } from '../system-assessment/strategy-binding'
import { AlphaBaselineSourceSchema, type AlphaBaselineSource } from '../system-assessment/alpha-observation-witness'
import { ReplayBrokerFailure } from './broker'

export const prepareReplayAlphaBaselineSources = (
  binding: ResearchStrategyBinding,
  raw: readonly AlphaBaselineSource[],
) =>
  Result.gen(function* () {
    const sources = yield* Schema.decodeUnknownResult(Schema.Array(AlphaBaselineSourceSchema), strictParseOptions)(raw)
    if (binding.engine !== ResearchStrategyEngine.IntradayAlpha) {
      if (sources.length !== 0)
        return yield* Result.fail(
          new ReplayBrokerFailure({ message: 'Only the bound alpha engine may use retained alpha baselines' }),
        )
      return sources
    }
    const protocolHash = yield* canonicalHashV1Result(binding.parameters.sharedProtocol)
    const seen = new Set<string>()
    for (const source of sources) {
      const reproduced = yield* reproduceIntradayAlphaObservation(source.payload)
      if (
        reproduced.contentHash !== source.observationHash ||
        seen.has(source.observationHash) ||
        Date.parse(source.availableAt) < Date.parse(reproduced.observedAt) ||
        (yield* canonicalHashV1Result(reproduced.protocol)) !== protocolHash ||
        reproduced.trailingBaseline.lookbackSessions !== binding.parameters.trailingBaseline.lookbackSessions ||
        reproduced.trailingBaseline.sessionDate !== reproduced.snapshot.manifest.sessionDate ||
        reproduced.trailingBaseline.latestPriorSessionDate >= reproduced.snapshot.manifest.sessionDate
      )
        return yield* Result.fail(
          new ReplayBrokerFailure({
            message: 'Retained alpha baseline differs from its observation, policy or causal witness',
          }),
        )
      seen.add(source.observationHash)
    }
    return sources
  })

const queryMatches = (
  query: TrailingBaselineQuery,
  binding: Extract<ResearchStrategyBinding, { engine: ResearchStrategyEngine.IntradayAlpha }>,
) =>
  query.lookbackSessions === binding.parameters.trailingBaseline.lookbackSessions &&
  query.minimumSessions === binding.parameters.trailingBaseline.minimumSessions &&
  [...query.symbols].sort().join('|') === [...binding.parameters.candidateSymbols].sort().join('|') &&
  [...query.noiseAreaSymbols].sort().join('|') === [...binding.parameters.noiseAreaSymbols].sort().join('|')

export const selectReplayAlphaBaselineSource = (
  binding: ResearchStrategyBinding,
  sources: readonly AlphaBaselineSource[],
  query: TrailingBaselineQuery,
  observedAt: string,
): Result.Result<AlphaBaselineSource, OperationalError> => {
  const fail = (message: string) =>
    Result.fail(operationalError({ component: 'market-data', operation: 'replay-alpha-baseline', message }))
  if (binding.engine !== ResearchStrategyEngine.IntradayAlpha || !queryMatches(query, binding))
    return fail('Replay baseline query differs from its explicitly bound alpha policy')
  const source = sources
    .filter(
      (source) =>
        Date.parse(source.availableAt) <= Date.parse(observedAt) &&
        source.payload.trailingBaseline.sessionDate === query.sessionDate &&
        source.payload.trailingBaseline.latestPriorSessionDate < query.sessionDate &&
        query.sourceContract.provider === 'alpaca' &&
        query.sourceContract.feed === intradayAlphaEquityMarketProfile.feed &&
        query.sourceContract.sourceTopic === intradayAlphaEquityMarketProfile.sourceTopics.bars &&
        query.sourceContract.universeId === intradayAlphaEquityMarketProfile.universeId,
    )
    .toSorted(
      (a, b) =>
        Date.parse(b.availableAt) - Date.parse(a.availableAt) || a.observationHash.localeCompare(b.observationHash),
    )[0]
  return source === undefined
    ? Result.fail(
        retryableOperationalError({
          component: 'market-data',
          operation: 'replay-alpha-baseline',
          message: 'No retained alpha baseline was independently available at this replay checkpoint',
        }),
      )
    : Result.succeed(source)
}

export const selectReplayAlphaBaseline = (
  binding: ResearchStrategyBinding,
  sources: readonly AlphaBaselineSource[],
  query: TrailingBaselineQuery,
  observedAt: string,
) =>
  selectReplayAlphaBaselineSource(binding, sources, query, observedAt).pipe(
    Result.map((source) => source.payload.trailingBaseline),
  )

export const makeReplayAlphaTrailingBaseline = (
  binding: ResearchStrategyBinding,
  sources: readonly AlphaBaselineSource[],
  observedAt: Effect.Effect<string>,
): IntradayTrailingBaselineService => ({
  load: (query) =>
    observedAt.pipe(Effect.flatMap((at) => Effect.fromResult(selectReplayAlphaBaseline(binding, sources, query, at)))),
})
