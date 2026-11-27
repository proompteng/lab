import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { preparedAlphaBaselineFixture } from '../observe-composition/alpha-baseline-preparation.test-support'
import { strictParseOptions } from '../schemas'
import { supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { bindSystemSourceCut } from './bind-source'
import { SystemAssessmentError } from './economics'
import { preparedAlphaRegistrationFixture } from './prepared-alpha-registration.test-support'
import { strategyBoundRegistrationFixture } from './strategy-registration.test-support'
import { emptySourceCutFixture } from './source-cut.test-support'
import {
  PreparedAlphaSystemSourceCutSchema,
  StrategyBoundSystemSourceCutSchema,
  SystemSourceCutSchema,
} from './source-cut'

describe('prospective preparation source cut version boundary', () => {
  test('registered v6 and v7 reject every other source-cut version before economic binding', () => {
    for (const registration of [strategyBoundRegistrationFixture(), preparedAlphaRegistrationFixture()]) {
      const { cut, input, verifiedSources } = emptySourceCutFixture(
        supportedAssessmentFixture(registration.calendar.sessions.length, registration),
      )
      const versions = [
        cut,
        { ...cut, schemaVersion: 'bayn.system-source-cut.v5' as const, alphaObservations: [] },
        {
          ...cut,
          schemaVersion: 'bayn.system-source-cut.v6' as const,
          alphaObservations: [],
          alphaBaselinePreparations: [],
        },
      ]
      for (const candidate of versions) {
        if (
          registration.schemaVersion === 'bayn.system-registration.v6' &&
          candidate.schemaVersion === 'bayn.system-source-cut.v5'
        )
          continue
        if (
          registration.schemaVersion === 'bayn.system-registration.v7' &&
          candidate.schemaVersion === 'bayn.system-source-cut.v6'
        )
          continue
        const result = bindSystemSourceCut({ ...input, sourceCutHash: testHash(candidate) }, candidate, verifiedSources)
        if (Result.isSuccess(result)) throw new Error('Mismatched source version was accepted')
        if (!(result.failure instanceof SystemAssessmentError)) throw new Error('Expected typed source-version failure')
        expect(result.failure.message).toBe('Source cut version differs from the registered native engine contract')
      }
    }
  })

  test('retained v5 preserves its bytes and rejects preparation fields and witnesses', () => {
    const { cut } = emptySourceCutFixture()
    const retained = { ...cut, schemaVersion: 'bayn.system-source-cut.v5' as const, alphaObservations: [] }
    const decoded = Schema.decodeUnknownSync(SystemSourceCutSchema, strictParseOptions)(retained)
    expect(decoded).toEqual(retained)
    expect(testHash(decoded)).toBe(testHash(retained))
    for (const changed of [
      { ...retained, alphaBaselinePreparations: [] },
      {
        ...retained,
        durableObservations: [
          {
            kind: 'ALPHA_BASELINE',
            sourceHash: testHash('source'),
            sourceAt: cut.asOf,
            witnessedAt: cut.asOf,
            correct: true,
          },
        ],
      },
    ])
      expect(Result.isFailure(Schema.decodeUnknownResult(SystemSourceCutSchema, strictParseOptions)(changed))).toBe(
        true,
      )
  })

  test('v6 requires an explicit preparation inventory and preserves the complete authenticated payload', () => {
    const { cut } = emptySourceCutFixture()
    const source = preparedAlphaBaselineFixture()
    const current = {
      ...cut,
      schemaVersion: 'bayn.system-source-cut.v6' as const,
      asOf: '2026-09-04T12:02:00.000Z',
      alphaObservations: [],
      alphaBaselinePreparations: [source],
      durableObservations: [
        {
          kind: 'ALPHA_BASELINE' as const,
          sourceHash: source.contentHash,
          sourceAt: source.recordedAt,
          witnessedAt: '2026-09-04T12:01:04.000Z',
          correct: true,
        },
      ],
    }
    const decoded = Schema.decodeUnknownSync(PreparedAlphaSystemSourceCutSchema, strictParseOptions)(current)
    expect(decoded).toEqual(current)
    expect(testHash(decoded)).toBe(testHash(current))
    expect(Schema.decodeUnknownSync(SystemSourceCutSchema, strictParseOptions)(current)).toEqual(current)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(StrategyBoundSystemSourceCutSchema, strictParseOptions)(current)),
    ).toBe(true)
    const { alphaBaselinePreparations: _inventory, ...missing } = current
    expect(Result.isFailure(Schema.decodeUnknownResult(SystemSourceCutSchema, strictParseOptions)(missing))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(
          SystemSourceCutSchema,
          strictParseOptions,
        )({ ...current, alphaBaselinePreparations: [{ ...source, availableAt: source.recordedAt }] }),
      ),
    ).toBe(true)
  })
})
