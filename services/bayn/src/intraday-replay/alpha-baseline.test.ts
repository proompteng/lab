import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { makeResearchStrategyBinding, ResearchStrategyEngine } from '../system-assessment/strategy-binding'
import { loadSharedJevProtocol } from '../strategy'
import { intradayAlphaEquityMarketProfile } from '../strategy/intraday-alpha/policy'
import { alphaReplayBaselineFixture } from './alpha-replay.test-support'
import { prepareReplayAlphaBaselineSources, selectReplayAlphaBaseline } from './alpha-baseline'

test('alpha replay uses only the witnessed baseline available at its original observation cut', () => {
  const { binding, source } = alphaReplayBaselineFixture()
  if (binding.engine !== ResearchStrategyEngine.IntradayAlpha) throw new Error('Missing alpha fixture')
  const sources = Result.getOrThrow(prepareReplayAlphaBaselineSources(binding, [source]))
  const query = {
    sessionDate: source.payload.trailingBaseline.sessionDate,
    symbols: binding.parameters.candidateSymbols,
    noiseAreaSymbols: binding.parameters.noiseAreaSymbols,
    lookbackSessions: binding.parameters.trailingBaseline.lookbackSessions,
    minimumSessions: binding.parameters.trailingBaseline.minimumSessions,
    sourceContract: {
      provider: 'alpaca',
      feed: intradayAlphaEquityMarketProfile.feed,
      sourceTopic: intradayAlphaEquityMarketProfile.sourceTopics.bars,
      universeId: intradayAlphaEquityMarketProfile.universeId,
    },
  }
  const early = selectReplayAlphaBaseline(binding, sources, query, source.payload.observedAt)
  expect(Result.isFailure(early)).toBe(true)
  if (Result.isFailure(early)) expect(early.failure.retryable).toBe(true)
  expect(Result.getOrThrow(selectReplayAlphaBaseline(binding, sources, query, source.availableAt))).toEqual(
    source.payload.trailingBaseline,
  )
  expect(Result.isFailure(selectReplayAlphaBaseline(binding, [], query, source.availableAt))).toBe(true)
  expect(
    Result.isFailure(
      selectReplayAlphaBaseline(binding, sources, { ...query, lookbackSessions: 13 }, source.availableAt),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(selectReplayAlphaBaseline(binding, sources, { ...query, symbols: ['SPY'] }, source.availableAt)),
  ).toBe(true)
  expect(
    Result.isFailure(
      selectReplayAlphaBaseline(
        binding,
        sources,
        { ...query, sourceContract: { ...query.sourceContract, feed: 'sip' } },
        source.availableAt,
      ),
    ),
  ).toBe(true)
  expect(Result.getOrThrow(selectReplayAlphaBaseline(binding, sources, query, source.availableAt))).not.toHaveProperty(
    'portfolio',
  )
})

test('alpha replay rejects mutated observations, duplicate identities, premature witnesses and engine aliasing', () => {
  const { binding, source } = alphaReplayBaselineFixture()
  const earlier = new Date(Date.parse(source.payload.observedAt) - 1).toISOString()
  const mutated = {
    ...source.payload,
    trailingBaseline: {
      ...source.payload.trailingBaseline,
      latestPriorSessionDate: source.payload.trailingBaseline.sessionDate,
    },
  }
  for (const sources of [
    [source, source],
    [{ ...source, observationHash: '0'.repeat(64) }],
    [{ ...source, availableAt: earlier }],
    [{ ...source, payload: mutated, observationHash: Result.getOrThrow(canonicalHashV1Result(mutated)) }],
  ])
    expect(Result.isFailure(prepareReplayAlphaBaselineSources(binding, sources))).toBe(true)
  const jev = Result.getOrThrow(
    makeResearchStrategyBinding({
      engine: ResearchStrategyEngine.Jev,
      parameters: Result.getOrThrow(loadSharedJevProtocol()),
    }),
  )
  expect(Result.isFailure(prepareReplayAlphaBaselineSources(jev, [source]))).toBe(true)
  expect(Result.getOrThrow(prepareReplayAlphaBaselineSources(jev, []))).toEqual([])
})
