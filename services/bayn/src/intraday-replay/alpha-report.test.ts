import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import {
  makeOwnedIntradayAlphaObservation,
  reproduceIntradayAlphaObservation,
} from '../strategy/intraday-alpha/observation'
import { makeAlphaStreamingSnapshot, makeFlatAlphaPortfolio } from '../strategy/intraday-alpha/test-support'
import { makeResearchStrategyBinding, ResearchStrategyEngine } from '../system-assessment/strategy-binding'
import { alphaReplayBaselineFixture } from './alpha-replay.test-support'
import { ReplayAlphaObservationSchema, verifyReplayAlphaEvidence } from './alpha-report'
import { replayAlphaObservationFixture } from './alpha-baseline-use.test-support'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { strictParseOptions } from '../schemas'

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
    return replayAlphaObservationFixture({ contentHash: observation.contentHash, payload: observation.payload }, source)
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
    [{ ...row, payload, contentHash: Result.getOrThrow(canonicalHashV1Result(payload)) }],
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

test('a later baseline witness cannot replace the source selected before broker reads refresh the snapshot', () => {
  const { binding, source } = alphaReplayBaselineFixture()
  if (binding.engine !== ResearchStrategyEngine.IntradayAlpha) throw new Error('Missing alpha policy')
  const current = makeAlphaStreamingSnapshot({ minutesFromOpen: 121, profiles: {} })
  const admissionObservedAt = current.observedAt
  const refreshedAt = new Date(Date.parse(admissionObservedAt) + 1000).toISOString()
  const refreshed = Result.getOrThrow(
    constructStreamingSnapshot(current.cut, { ...current.query, observedAt: refreshedAt }),
  )
  const laterPayload = {
    ...source.payload,
    trailingBaseline: { ...source.payload.trailingBaseline, latestPriorSessionDate: '2026-09-02' as const },
  }
  const later = {
    ...source,
    payload: laterPayload,
    observationHash: Result.getOrThrow(canonicalHashV1Result(laterPayload)),
    availableAt: new Date(Date.parse(admissionObservedAt) + 500).toISOString(),
    witnessSourceHash: 'd'.repeat(64),
  }
  expect(Result.isSuccess(reproduceIntradayAlphaObservation(later.payload))).toBe(true)
  const runId = 'a'.repeat(64)
  const observe = (selected: typeof source) => {
    const observed = Result.getOrThrow(
      makeOwnedIntradayAlphaObservation({
        cycleId: 'b'.repeat(64),
        authorityGenerationHash: 'c'.repeat(64),
        protocol: binding.parameters.sharedProtocol,
        portfolio: makeFlatAlphaPortfolio(admissionObservedAt, '100000000000', '100000000000', `replay-${runId}`),
        snapshot: refreshed,
        trailingBaseline: selected.payload.trailingBaseline,
      }),
    )
    return replayAlphaObservationFixture({ contentHash: observed.contentHash, payload: observed.payload }, selected, {
      admissionObservedAt,
      commandIssuedAt: admissionObservedAt,
    })
  }
  const original = observe(source)
  const input = { binding, sources: [source, later], observations: [original], baselineGaps: [], decisions: [], runId }
  expect(Result.isSuccess(verifyReplayAlphaEvidence(input))).toBe(true)
  expect(Result.isFailure(verifyReplayAlphaEvidence({ ...input, observations: [observe(later)] }))).toBe(true)
  for (const change of [
    { observationHash: 'e'.repeat(64) },
    { cycleId: 'e'.repeat(64) },
    { authorityGenerationHash: 'e'.repeat(64) },
    { sourceObservationHash: later.observationHash },
    { sourceWitnessHash: later.witnessSourceHash },
    { baselineHash: 'e'.repeat(64) },
    { admissionObservedAt: new Date(Date.parse(refreshedAt) + 1).toISOString() },
    { admissionExpiresAt: refreshedAt },
    { commandIssuedAt: refreshedAt },
    { windowEndAt: new Date(Date.parse(original.baselineUse.windowEndAt) - 60_000).toISOString() },
  ])
    expect(
      Result.isFailure(
        verifyReplayAlphaEvidence({
          ...input,
          observations: [{ ...original, baselineUse: { ...original.baselineUse, ...change } }],
        }),
      ),
    ).toBe(true)
  const release = {
    observationHash: original.contentHash,
    commandIssuedAt: admissionObservedAt,
    observedAt: refreshedAt,
    completedAt: refreshedAt,
    releaseFloorAt: refreshedAt,
    releasedAt: refreshedAt,
  }
  expect(Result.isSuccess(verifyReplayAlphaEvidence({ ...input, observationReleases: [release] }))).toBe(true)
  expect(Result.isFailure(verifyReplayAlphaEvidence({ ...input, observationReleases: [release, release] }))).toBe(true)
  expect(
    Result.isFailure(
      verifyReplayAlphaEvidence({ ...input, observationReleases: [{ ...release, observationHash: 'f'.repeat(64) }] }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      verifyReplayAlphaEvidence({
        ...input,
        observationReleases: [
          { ...release, commandIssuedAt: new Date(Date.parse(admissionObservedAt) - 1).toISOString() },
        ],
      }),
    ),
  ).toBe(true)
  const { baselineUse: _receipt, ...unbound } = original
  expect(Result.isFailure(Schema.decodeUnknownResult(ReplayAlphaObservationSchema, strictParseOptions)(unbound))).toBe(
    true,
  )
}, 60000)
