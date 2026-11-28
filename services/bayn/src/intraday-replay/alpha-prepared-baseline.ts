import { Result, Schema } from 'effect'

import { operationalError, retryableOperationalError, type OperationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import type { TrailingBaselineQuery } from '../market-data/intraday/trailing-baseline'
import { reproduceRecordedAlphaBaselinePreparation } from '../observe-composition/alpha-baseline-preparation'
import { strictParseOptions } from '../schemas'
import { intradayAlphaEquityMarketProfile } from '../strategy/intraday-alpha/policy'
import {
  PreparedAlphaBaselineSourceSchema,
  type PreparedAlphaBaselineSource,
} from '../system-assessment/alpha-baseline-witness'
import { ResearchStrategyEngine, type ResearchStrategyBinding } from '../system-assessment/strategy-binding'
import { ReplayBrokerFailure } from './broker'

const canonicalQuery = (query: TrailingBaselineQuery) => ({
  ...query,
  symbols: [...query.symbols].sort(),
  noiseAreaSymbols: [...query.noiseAreaSymbols].sort(),
})

/** Raw studies retain declared source provenance; registered studies independently derive the entire array from their source cut. */
export const prepareReplayAlphaBaselinePreparations = (
  binding: ResearchStrategyBinding,
  raw: readonly PreparedAlphaBaselineSource[],
) =>
  Result.gen(function* () {
    const sources = yield* Schema.decodeUnknownResult(
      Schema.Array(PreparedAlphaBaselineSourceSchema),
      strictParseOptions,
    )(raw)
    const fail = (message: string) => Result.fail(new ReplayBrokerFailure({ message }))
    if (binding.engine !== ResearchStrategyEngine.IntradayAlpha) {
      if (sources.length !== 0)
        return yield* fail('Only the explicitly bound alpha engine may consume prepared alpha baselines')
      return sources
    }
    const policyHash = yield* canonicalHashV1Result(binding.parameters)
    const seen = new Set<string>()
    for (const source of sources) {
      const record = yield* reproduceRecordedAlphaBaselinePreparation({
        contentHash: source.preparationHash,
        payload: source.payload,
        recordedAt: source.recordedAt,
      })
      if (
        seen.has(source.preparationHash) ||
        source.availableAt < record.recordedAt ||
        (yield* canonicalHashV1Result(record.payload.policy)) !== policyHash
      )
        return yield* fail(
          'Prepared alpha baseline differs from its complete source, policy or independent witness time',
        )
      seen.add(source.preparationHash)
    }
    return sources
  })

export const selectReplayAlphaBaselinePreparation = (
  binding: ResearchStrategyBinding,
  preparations: readonly PreparedAlphaBaselineSource[],
  query: TrailingBaselineQuery,
  commandIssuedAt: string,
): Result.Result<PreparedAlphaBaselineSource, OperationalError> =>
  Result.gen(function* () {
    const fail = (message: string) =>
      Result.fail(operationalError({ component: 'market-data', operation: 'replay-alpha-baseline', message }))
    if (
      binding.engine !== ResearchStrategyEngine.IntradayAlpha ||
      !Number.isFinite(Date.parse(commandIssuedAt)) ||
      query.lookbackSessions !== binding.parameters.trailingBaseline.lookbackSessions ||
      query.minimumSessions !== binding.parameters.trailingBaseline.minimumSessions ||
      [...query.symbols].sort().join('|') !== [...binding.parameters.candidateSymbols].sort().join('|') ||
      [...query.noiseAreaSymbols].sort().join('|') !== [...binding.parameters.noiseAreaSymbols].sort().join('|') ||
      query.sourceContract.provider !== 'alpaca' ||
      query.sourceContract.feed !== intradayAlphaEquityMarketProfile.feed ||
      query.sourceContract.sourceTopic !== intradayAlphaEquityMarketProfile.sourceTopics.bars ||
      query.sourceContract.universeId !== intradayAlphaEquityMarketProfile.universeId
    )
      return yield* fail('Prepared replay baseline query differs from its explicit engine or original command')
    const queryHash = yield* canonicalHashV1Result(canonicalQuery(query)).pipe(
      Result.mapError((cause) =>
        operationalError({
          component: 'market-data',
          operation: 'replay-alpha-baseline',
          message: 'Prepared baseline query is invalid',
          cause,
        }),
      ),
    )
    const available: PreparedAlphaBaselineSource[] = []
    for (const source of preparations) {
      if (Date.parse(source.availableAt) > Date.parse(commandIssuedAt)) continue
      const sourceQueryHash = yield* canonicalHashV1Result(canonicalQuery(source.payload.acquisition.query)).pipe(
        Result.mapError((cause) =>
          operationalError({
            component: 'market-data',
            operation: 'replay-alpha-baseline',
            message: 'Prepared baseline source query is invalid',
            cause,
          }),
        ),
      )
      if (sourceQueryHash === queryHash) available.push(source)
    }
    const source = available.toSorted(
      (a, b) => b.availableAt.localeCompare(a.availableAt) || a.preparationHash.localeCompare(b.preparationHash),
    )[0]
    if (source === undefined)
      return yield* Result.fail(
        retryableOperationalError({
          component: 'market-data',
          operation: 'replay-alpha-baseline',
          message: 'No prepared alpha baseline was independently available before this original replay command',
        }),
      )
    return source
  })
