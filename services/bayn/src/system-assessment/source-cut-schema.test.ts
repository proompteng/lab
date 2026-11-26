import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { strictParseOptions } from '../schemas'
import { testHash } from './fixtures.test-support'
import { emptySourceCutFixture } from './source-cut.test-support'
import { RetainedSystemSourceCutSchema, StrategyBoundSystemSourceCutSchema, SystemSourceCutSchema } from './source-cut'

describe('versioned system source cuts', () => {
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
    const current = { ...cut, schemaVersion: 'bayn.system-source-cut.v5', alphaObservations: [] }
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
        kind: 'ALPHA_OBSERVATION',
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
