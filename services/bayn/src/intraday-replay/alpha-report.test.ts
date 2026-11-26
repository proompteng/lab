import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import {
  makeOwnedIntradayAlphaObservation,
  reproduceIntradayAlphaObservation,
} from '../strategy/intraday-alpha/observation'
import { makeAlphaStreamingSnapshot, makeFlatAlphaPortfolio } from '../strategy/intraday-alpha/test-support'
import { makeResearchStrategyBinding, ResearchStrategyEngine } from '../system-assessment/strategy-binding'
import { alphaReplayBaselineFixture } from './alpha-replay.test-support'
import { verifyReplayAlphaEvidence } from './alpha-report'

const fixture = () => {
  const { binding, source } = alphaReplayBaselineFixture()
  if (binding.engine !== ResearchStrategyEngine.IntradayAlpha) throw new Error('Missing native alpha fixture')
  const runId = 'a'.repeat(64)
  const current = makeAlphaStreamingSnapshot({ minutesFromOpen: 121, profiles: {} })
  const observe = (accountId: string) => {
    const observation = Result.getOrThrow(
      makeOwnedIntradayAlphaObservation({
        cycleId: 'b'.repeat(64),
        authorityGenerationHash: 'c'.repeat(64),
        protocol: binding.parameters.sharedProtocol,
        portfolio: makeFlatAlphaPortfolio(current.observedAt, '100000000000', '100000000000', accountId),
        snapshot: current.snapshot,
        trailingBaseline: source.payload.trailingBaseline,
      }),
    )
    return { contentHash: observation.contentHash, payload: observation.payload }
  }
  return {
    input: {
      binding,
      sources: [source],
      observations: [observe(`replay-${runId}`)],
      baselineGaps: [],
      decisions: [],
      runId,
    },
    observe,
  }
}

test('native alpha report authenticates replay-owned observations without borrowing source portfolio ownership', () => {
  const { input, observe } = fixture()
  expect(Result.getOrThrow(verifyReplayAlphaEvidence(input))).toHaveLength(1)
  const row = input.observations[0]
  if (row === undefined) throw new Error('Missing replay observation')
  const payload = {
    ...row.payload,
    trailingBaseline: { ...row.payload.trailingBaseline, latestPriorSessionDate: '2026-09-02' as const },
  }
  expect(Result.isSuccess(reproduceIntradayAlphaObservation(payload))).toBe(true)
  for (const observations of [
    [row, row],
    [{ ...row, contentHash: '0'.repeat(64) }],
    [observe('other-valid-replay-account')],
    [{ payload, contentHash: Result.getOrThrow(canonicalHashV1Result(payload)) }],
  ])
    expect(Result.isFailure(verifyReplayAlphaEvidence({ ...input, observations }))).toBe(true)
  expect(Result.isFailure(verifyReplayAlphaEvidence({ ...input, decisions: [{}] }))).toBe(true)
  expect(
    Result.isFailure(
      verifyReplayAlphaEvidence({
        ...input,
        sources: input.sources.map((source) => ({
          ...source,
          availableAt: new Date(Date.parse(row.payload.observedAt) + 1).toISOString(),
        })),
      }),
    ),
  ).toBe(true)
  const jev = Result.getOrThrow(
    makeResearchStrategyBinding({
      engine: ResearchStrategyEngine.Jev,
      parameters: input.binding.parameters.sharedProtocol,
    }),
  )
  expect(Result.isFailure(verifyReplayAlphaEvidence({ ...input, binding: jev }))).toBe(true)
})

test('native alpha report preserves the missing first causal baseline and rejects invented gap claims', () => {
  const { input } = fixture()
  const source = input.sources[0]
  if (source === undefined) throw new Error('Missing retained alpha source')
  const gap = {
    reason: 'MISSING_CAUSAL_ALPHA_BASELINE' as const,
    sessionDate: source.payload.trailingBaseline.sessionDate,
    observedAt: source.payload.observedAt,
    firstAvailableAt: source.availableAt,
  }
  const missing = { ...input, observations: [], baselineGaps: [gap] }
  expect(Result.isSuccess(verifyReplayAlphaEvidence(missing))).toBe(true)
  expect(
    Result.isSuccess(
      verifyReplayAlphaEvidence({ ...missing, sources: [], baselineGaps: [{ ...gap, firstAvailableAt: null }] }),
    ),
  ).toBe(true)
  for (const baselineGaps of [
    [gap, gap],
    [{ ...gap, firstAvailableAt: null }],
    [{ ...gap, observedAt: source.availableAt }],
  ])
    expect(Result.isFailure(verifyReplayAlphaEvidence({ ...missing, baselineGaps }))).toBe(true)
})
