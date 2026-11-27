import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { reproduceAlphaBaselinePreparation } from '../observe-composition/alpha-baseline-preparation'
import { makeOwnedIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import { makeAlphaStreamingSnapshot, makeFlatAlphaPortfolio } from '../strategy/intraday-alpha/test-support'
import { makeResearchStrategyBinding, ResearchStrategyEngine } from '../system-assessment/strategy-binding'
import { prepareReplayAlphaBaselinePreparations, selectReplayAlphaBaselinePreparation } from './alpha-prepared-baseline'
import {
  preparedReplayAlphaBaselineFixture,
  preparedReplayAlphaObservationFixture,
} from './alpha-prepared-baseline.test-support'
import {
  PreparedReplayAlphaObservationSchema,
  ReplayAlphaObservationSchema,
  verifyPreparedReplayAlphaEvidence,
} from './alpha-report'
import { strictParseOptions } from '../schemas'

test('prepared replay sources require full reproduced acquisition and preserve their producer identity', () => {
  const { binding, source } = preparedReplayAlphaBaselineFixture()
  const query = source.payload.acquisition.query
  expect(Result.getOrThrow(prepareReplayAlphaBaselinePreparations(binding, [source]))).toEqual([source])
  expect(Result.getOrThrow(selectReplayAlphaBaselinePreparation(binding, [source], query, source.availableAt))).toEqual(
    source,
  )
  expect(Result.isFailure(selectReplayAlphaBaselinePreparation(binding, [source], query, source.recordedAt))).toBe(true)
  for (const sources of [
    [source, source],
    [{ ...source, preparationHash: '0'.repeat(64) }],
    [{ ...source, recordedAt: source.payload.acquisition.startedAt }],
    [{ ...source, availableAt: source.payload.acquisition.startedAt }],
    [
      {
        ...source,
        payload: {
          ...source.payload,
          acquisition: {
            ...source.payload.acquisition,
            inputs: { ...source.payload.acquisition.inputs, intradayDailyRows: [] },
          },
        },
      },
    ],
  ])
    expect(Result.isFailure(prepareReplayAlphaBaselinePreparations(binding, sources))).toBe(true)
  expect(
    Result.isFailure(
      selectReplayAlphaBaselinePreparation(
        binding,
        [source],
        { ...query, sourceContract: { ...query.sourceContract, sourceTopic: 'unrelated' } },
        source.availableAt,
      ),
    ),
  ).toBe(true)
  const jev = Result.getOrThrow(
    makeResearchStrategyBinding({
      engine: ResearchStrategyEngine.Jev,
      parameters: source.payload.policy.sharedProtocol,
    }),
  )
  expect(Result.isSuccess(prepareReplayAlphaBaselinePreparations(jev, []))).toBe(true)
  expect(Result.isFailure(prepareReplayAlphaBaselinePreparations(jev, [source]))).toBe(true)
})

const observationFixture = () => {
  const { binding, source } = preparedReplayAlphaBaselineFixture()
  const runId = 'b'.repeat(64)
  const current = makeAlphaStreamingSnapshot({ minutesFromOpen: 121, profiles: {} })
  const commandIssuedAt = new Date(Date.parse(current.observedAt) - 100).toISOString()
  const observe = (selected = source, accountId = `replay-${runId}`) => {
    const observation = Result.getOrThrow(
      makeOwnedIntradayAlphaObservation({
        cycleId: 'c'.repeat(64),
        authorityGenerationHash: 'd'.repeat(64),
        protocol: source.payload.policy.sharedProtocol,
        portfolio: makeFlatAlphaPortfolio(current.observedAt, '100000000000', '100000000000', accountId),
        snapshot: current.snapshot,
        trailingBaseline: selected.payload.acquisition.trailingBaseline,
      }),
    )
    return preparedReplayAlphaObservationFixture(
      { contentHash: observation.contentHash, payload: observation.payload },
      selected,
      { commandIssuedAt },
    )
  }
  return { binding, source, runId, current, commandIssuedAt, observe }
}

test('v13 verification uses the actual original command, not later admission or snapshot availability', () => {
  const f = observationFixture()
  const row = f.observe()
  const input = {
    binding: f.binding,
    preparations: [f.source],
    observations: [row],
    baselineGaps: [],
    decisions: [],
    runId: f.runId,
  }
  expect(Result.getOrThrow(verifyPreparedReplayAlphaEvidence(input))).toHaveLength(1)
  const late = preparedReplayAlphaBaselineFixture(new Date(Date.parse(f.commandIssuedAt) + 1).toISOString()).source
  expect(Date.parse(late.availableAt)).toBeLessThan(Date.parse(row.baselineUse.admissionObservedAt))
  expect(
    Result.isFailure(
      verifyPreparedReplayAlphaEvidence({ ...input, preparations: [late], observations: [f.observe(late)] }),
    ),
  ).toBe(true)
  for (const change of [
    { sourcePreparationHash: '0'.repeat(64) },
    { sourceWitnessHash: '0'.repeat(64) },
    { baselineHash: '0'.repeat(64) },
    { commandIssuedAt: f.source.recordedAt },
    { commandIssuedAt: new Date(Date.parse(row.payload.observedAt) + 1).toISOString() },
    { admissionExpiresAt: row.payload.observedAt },
  ])
    expect(
      Result.isFailure(
        verifyPreparedReplayAlphaEvidence({
          ...input,
          observations: [{ ...row, baselineUse: { ...row.baselineUse, ...change } }],
        }),
      ),
    ).toBe(true)
  expect(
    Result.isFailure(
      verifyPreparedReplayAlphaEvidence({ ...input, observations: [f.observe(f.source, f.source.payload.accountId)] }),
    ),
  ).toBe(true)
  expect(Result.isFailure(Schema.decodeUnknownResult(ReplayAlphaObservationSchema, strictParseOptions)(row))).toBe(true)
  const { sourcePreparationHash: _source, ...use } = row.baselineUse
  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(
        PreparedReplayAlphaObservationSchema,
        strictParseOptions,
      )({
        ...row,
        baselineUse: {
          ...use,
          schemaVersion: 'bayn.replay-alpha-baseline-use.v1',
          sourceObservationHash: f.source.preparationHash,
        },
      }),
    ),
  ).toBe(true)
})

test('prepared replay never replaces a late first command with an unverified empty or earlier baseline', () => {
  const f = observationFixture()
  const gap = {
    reason: 'MISSING_CAUSAL_ALPHA_BASELINE' as const,
    sessionDate: f.source.payload.sessionDate,
    observedAt: f.source.recordedAt,
    firstAvailableAt: f.source.availableAt,
  }
  const input = {
    binding: f.binding,
    preparations: [f.source],
    observations: [],
    baselineGaps: [gap],
    decisions: [],
    runId: f.runId,
  }
  expect(Result.isSuccess(verifyPreparedReplayAlphaEvidence(input))).toBe(true)
  expect(
    Result.isSuccess(
      verifyPreparedReplayAlphaEvidence({
        ...input,
        preparations: [],
        baselineGaps: [{ ...gap, firstAvailableAt: null }],
      }),
    ),
  ).toBe(true)
  for (const baselineGaps of [
    [gap, gap],
    [{ ...gap, firstAvailableAt: null }],
    [{ ...gap, observedAt: f.source.availableAt }],
  ])
    expect(Result.isFailure(verifyPreparedReplayAlphaEvidence({ ...input, baselineGaps }))).toBe(true)
  const changed = Result.getOrThrow(
    reproduceAlphaBaselinePreparation({
      ...f.source.payload,
      executionBuild: { ...f.source.payload.executionBuild, sourceRevision: '0'.repeat(40) },
    }),
  )
  const otherProducer = { ...f.source, preparationHash: changed.contentHash, payload: changed.payload }
  const row = f.observe()
  expect(
    Result.isFailure(
      verifyPreparedReplayAlphaEvidence({
        ...input,
        baselineGaps: [],
        preparations: [otherProducer],
        observations: [row],
      }),
    ),
  ).toBe(true)
  expect(Result.getOrThrow(canonicalHashV1Result(otherProducer.payload))).not.toBe(f.source.preparationHash)
})
