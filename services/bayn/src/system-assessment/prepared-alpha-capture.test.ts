import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { JevResearchPolicy } from '../jev/acceptance'
import { SnapshotCalendarSchema } from '../market-data/streaming/manifest-schema'
import { preparedAlphaBaselineFixture } from '../observe-composition/alpha-baseline-preparation.test-support'
import type { RecordedAlphaBaselinePreparation } from '../observe-composition/alpha-baseline-preparation'
import { IsoDateSchema, strictParseOptions } from '../schemas'
import { verifyRegisteredAlphaBaselinePreparations } from './alpha-baseline-capture'
import { derivePreparedAlphaBaselineSources } from './alpha-baseline-witness'
import { deriveAlphaBaselineSources, earliestAlphaObservationWitness } from './alpha-observation-witness'
import {
  nativeRegistrationFixture,
  registrationFixture,
  testHash,
  withRegistrationCommitments,
} from './fixtures.test-support'
import { preparedAlphaSystemLatencyStressProtocolHash } from './latency-protocol'
import { alphaLatencyFixture } from './native-alpha-latency.test-support'
import { measureRegisteredDecisionLatency } from './native-decision-latency'
import { PreparedAlphaSystemRegistrationSchema, preparedAlphaSystemQualificationPolicyHash } from './policy'
import { preparedAlphaRegistrationFixture } from './prepared-alpha-registration.test-support'
import { PreparedAlphaSystemSourceCutSchema } from './source-cut'
import { ResearchStrategyEngine } from './strategy-binding'

const providerCalendar = (close = '16:00', sessionOpen = '0400', sessionClose = '2000') =>
  Schema.decodeUnknownSync(
    SnapshotCalendarSchema,
    strictParseOptions,
  )(
    Result.getOrThrow(
      normalizeMarketCalendarResult(
        ['2026-09-04', '2026-09-08'].map((date) => ({
          date: Schema.decodeUnknownSync(IsoDateSchema)(date),
          open: '09:30',
          close,
          session_open: sessionOpen,
          session_close: sessionClose,
        })),
        { start: '2026-09-04', end: '2026-09-08' },
      ),
    ),
  )

const withPayload = (
  source: RecordedAlphaBaselinePreparation,
  payload: RecordedAlphaBaselinePreparation['payload'],
): RecordedAlphaBaselinePreparation => ({ ...source, payload, contentHash: testHash(payload) })

const captureFixture = (close = '16:00') => {
  const base = registrationFixture(undefined, 2)
  const bound = preparedAlphaRegistrationFixture(
    nativeRegistrationFixture({ ...base, registeredAt: '2026-09-01T00:00:00.000Z' }, providerCalendar(close)),
  )
  const registration = withRegistrationCommitments({
    ...bound,
    policies: bound.policies.map((definition) => ({
      ...definition,
      inferenceRateCard: {
        ...definition.inferenceRateCard,
        rates: definition.inferenceRateCard.rates.map((rate) => ({
          ...rate,
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          effectiveUntil: '2026-09-09T00:00:00.000Z',
        })),
      },
    })),
  })
  const candidate = registration.policies.find((definition) => definition.policy === JevResearchPolicy.Candidate)
  if (candidate === undefined || candidate.strategyBinding.engine !== ResearchStrategyEngine.IntradayAlpha)
    throw new Error('Missing registered alpha candidate')
  const fixture = preparedAlphaBaselineFixture()
  const source = withPayload(fixture, {
    ...fixture.payload,
    accountId: candidate.riskPolicy.accountId,
    authorityGenerationHash: candidate.authorityGenerationHash,
    policy: candidate.strategyBinding.parameters,
    ...(close === '16:00' ? {} : { calendar: providerCalendar(close) }),
    executionBuild: {
      sourceRevision: candidate.sourceRevision,
      imageRepository:
        candidate.capitalAuthorization?.buildLineage.activation.imageRepository ?? 'registry.example/bayn',
      imageDigest: `sha256:${candidate.imageDigest}`,
    },
  })
  return { registration, candidate, source, asOf: '2026-09-04T12:02:00.000Z' }
}

describe('registered alpha preparation capture', () => {
  test('retains a real preparation scope independently of witness availability or whole calendar read range', () => {
    const { registration, source, asOf } = captureFixture()
    expect(testHash(source.payload.calendar)).not.toBe(registration.calendar.sourceHash)
    const rows = Result.getOrThrow(verifyRegisteredAlphaBaselinePreparations(registration, [source], asOf))
    expect(rows).toEqual([source])
    expect(
      Result.getOrThrow(
        derivePreparedAlphaBaselineSources({
          registrationHash: testHash(registration),
          asOf,
          alphaBaselinePreparations: rows,
          durableObservations: [],
        }),
      ),
    ).toEqual([])
  })

  test('uses exact target provider and native half-day bounds', () => {
    const { registration, source, asOf } = captureFixture('13:00')
    expect(Result.getOrThrow(verifyRegisteredAlphaBaselinePreparations(registration, [source], asOf))).toEqual([source])
    for (const calendar of [providerCalendar(), providerCalendar('13:00', '0500', '1900')])
      expect(
        Result.isFailure(
          verifyRegisteredAlphaBaselinePreparations(
            registration,
            [withPayload(source, { ...source.payload, calendar })],
            asOf,
          ),
        ),
      ).toBe(true)
  })

  test('rejects changed owner, generation, physical build, query, cutoff and duplicate acquisition scope', () => {
    const { registration, source, asOf } = captureFixture()
    const changed = [
      withPayload(source, { ...source.payload, accountId: 'another-account' }),
      withPayload(source, { ...source.payload, authorityGenerationHash: testHash('another-generation') }),
      withPayload(source, {
        ...source.payload,
        executionBuild: { ...source.payload.executionBuild, sourceRevision: '1'.repeat(40) },
      }),
      withPayload(source, {
        ...source.payload,
        executionBuild: { ...source.payload.executionBuild, imageDigest: `sha256:${testHash('another-image')}` },
      }),
      withPayload(source, {
        ...source.payload,
        acquisition: {
          ...source.payload.acquisition,
          query: { ...source.payload.acquisition.query, symbols: [] },
        },
      }),
      { ...source, contentHash: testHash('another-content') },
      { ...source, recordedAt: '2026-09-04T12:02:00.001Z' },
    ]
    for (const record of changed)
      expect(Result.isFailure(verifyRegisteredAlphaBaselinePreparations(registration, [record], asOf))).toBe(true)
    for (const second of [source, withPayload(source, { ...source.payload, cycleId: testHash('later-cycle') })])
      expect(Result.isFailure(verifyRegisteredAlphaBaselinePreparations(registration, [source, second], asOf))).toBe(
        true,
      )
    expect(
      Result.isFailure(
        verifyRegisteredAlphaBaselinePreparations(
          { ...registration, registeredAt: '2026-09-04T12:01:02.001Z' },
          [source],
          asOf,
        ),
      ),
    ).toBe(true)
  })

  test('never substitutes the alpha incumbent for a Jev candidate', () => {
    const { source, asOf } = captureFixture()
    const registration = preparedAlphaRegistrationFixture(undefined, {
      candidate: ResearchStrategyEngine.Jev,
      incumbent: ResearchStrategyEngine.IntradayAlpha,
    })
    expect(Result.getOrThrow(verifyRegisteredAlphaBaselinePreparations(registration, [], asOf))).toEqual([])
    expect(Result.isFailure(verifyRegisteredAlphaBaselinePreparations(registration, [source], asOf))).toBe(true)
  })

  test('v7 retains native observation calibration while prohibiting the old observation-baseline fallback', () => {
    const fixture = alphaLatencyFixture()
    const registration = Schema.decodeUnknownSync(
      PreparedAlphaSystemRegistrationSchema,
      strictParseOptions,
    )({
      ...fixture.registration,
      schemaVersion: 'bayn.system-registration.v7',
      policyHash: Result.getOrThrow(preparedAlphaSystemQualificationPolicyHash()),
      latencyStressProtocolHash: Result.getOrThrow(preparedAlphaSystemLatencyStressProtocolHash()),
    })
    const cut = Schema.decodeUnknownSync(
      PreparedAlphaSystemSourceCutSchema,
      strictParseOptions,
    )({
      ...fixture.cut,
      schemaVersion: 'bayn.system-source-cut.v6',
      registrationHash: testHash(registration),
      alphaBaselinePreparations: [],
    })
    const oldCalibration = Result.getOrThrow(
      measureRegisteredDecisionLatency(fixture.registration, fixture.cut, fixture.identity),
    )
    const calibration = Result.getOrThrow(measureRegisteredDecisionLatency(registration, cut, fixture.identity))
    expect(calibration.status).toBe(oldCalibration.status)
    expect(calibration.samples).toEqual(oldCalibration.samples)
    const observation = cut.alphaObservations[0]
    if (observation === undefined) throw new Error('Missing alpha observation fixture')
    expect(Result.getOrThrow(earliestAlphaObservationWitness(cut, observation.contentHash))).not.toBeNull()
    expect(Result.getOrThrow(deriveAlphaBaselineSources(cut))).toEqual([])
    expect(Result.getOrThrow(derivePreparedAlphaBaselineSources(cut))).toEqual([])
  })
})
