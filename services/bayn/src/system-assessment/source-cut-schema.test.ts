import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { strictParseOptions } from '../schemas'
import { supportedAssessmentFixture, testHash } from './fixtures.test-support'
import { emptySourceCutFixture } from './source-cut.test-support'
import { RetainedSystemSourceCutSchema, StrategyBoundSystemSourceCutSchema, SystemSourceCutSchema } from './source-cut'
import { bindSystemSourceCut } from './bind-source'
import { strategyBoundRegistrationFixture } from './strategy-registration.test-support'

describe('versioned system source cuts', () => {
  test('binds the source version to its admitted engine contract before accepting financial claims', () => {
    const retained = emptySourceCutFixture()
    const registration = strategyBoundRegistrationFixture()
    const current = emptySourceCutFixture(
      supportedAssessmentFixture(registration.calendar.sessions.length, registration),
    )
    const cases = [
      { ...current, cut: current.cut },
      {
        ...retained,
        cut: { ...retained.cut, schemaVersion: 'bayn.system-source-cut.v5' as const, alphaObservations: [] },
      },
    ]
    for (const { input, cut, verifiedSources } of cases) {
      const result = bindSystemSourceCut({ ...input, sourceCutHash: testHash(cut) }, cut, verifiedSources)
      if (Result.isSuccess(result)) throw new Error('Mismatched source version was accepted')
      expect(result.failure).toMatchObject({
        message: 'Source cut version differs from the registered native engine contract',
      })
    }
  })

  test('retains the exact v4 payload and hash without alpha fields', () => {
    const { cut } = emptySourceCutFixture()
    const decoded = Schema.decodeUnknownSync(SystemSourceCutSchema, strictParseOptions)(cut)
    expect(decoded).toEqual(cut)
    expect(testHash(decoded)).toBe(testHash(cut))
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(
          SystemSourceCutSchema,
          strictParseOptions,
        )({
          ...cut,
          alphaObservations: [],
        }),
      ),
    ).toBe(true)
  })

  test('requires an explicit alpha inventory for v5 and never relabels a retained cut', () => {
    const { cut } = emptySourceCutFixture()
    const current = { ...cut, schemaVersion: 'bayn.system-source-cut.v5' as const, alphaObservations: [] }
    expect(Schema.decodeUnknownSync(StrategyBoundSystemSourceCutSchema, strictParseOptions)(current)).toEqual(current)
    expect(Schema.decodeUnknownSync(SystemSourceCutSchema, strictParseOptions)(current)).toEqual(current)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(RetainedSystemSourceCutSchema, strictParseOptions)(current)),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(
          SystemSourceCutSchema,
          strictParseOptions,
        )({
          ...cut,
          schemaVersion: 'bayn.system-source-cut.v5',
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(
          SystemSourceCutSchema,
          strictParseOptions,
        )({
          ...current,
          alphaObservations: [{ contentHash: testHash('unverified payload'), payload: {} }],
        }),
      ),
    ).toBe(true)
  })

  test('accepts the independently witnessed alpha kind only in v5', () => {
    const { cut } = emptySourceCutFixture()
    const durableObservations = [
      {
        kind: 'ALPHA_OBSERVATION' as const,
        sourceHash: testHash('alpha observation'),
        sourceAt: cut.asOf,
        witnessedAt: cut.asOf,
        correct: true,
      },
    ]
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(
          SystemSourceCutSchema,
          strictParseOptions,
        )({
          ...cut,
          durableObservations,
        }),
      ),
    ).toBe(true)
    expect(
      Schema.decodeUnknownSync(
        SystemSourceCutSchema,
        strictParseOptions,
      )({
        ...cut,
        schemaVersion: 'bayn.system-source-cut.v5',
        alphaObservations: [],
        durableObservations,
      }).durableObservations,
    ).toEqual(durableObservations)
  })
})
