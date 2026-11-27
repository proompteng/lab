import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { preparedAlphaBaselineFixture } from '../observe-composition/alpha-baseline-preparation.test-support'
import { derivePreparedAlphaBaselineSources } from './alpha-baseline-witness'

test('an unwitnessed retained preparation remains unavailable; only the actual later witness supplies availability', () => {
  const source = preparedAlphaBaselineFixture()
  const cut = {
    registrationHash: 'b'.repeat(64),
    asOf: '2026-09-04T13:31:02.000Z',
    alphaBaselinePreparations: [source],
    durableObservations: [],
  }
  expect(Result.getOrThrow(derivePreparedAlphaBaselineSources(cut))).toEqual([])
  const witness = {
    kind: 'ALPHA_BASELINE',
    sourceHash: source.contentHash,
    sourceAt: source.recordedAt,
    witnessedAt: '2026-09-04T12:01:03.250Z',
    correct: true,
  }
  const [carrier] = Result.getOrThrow(derivePreparedAlphaBaselineSources({ ...cut, durableObservations: [witness] }))
  expect(carrier?.availableAt).toBe(witness.witnessedAt)
  expect(carrier?.recordedAt).toBe(source.recordedAt)
  expect(carrier?.witnessSourceHash).toBe(
    Result.getOrThrow(canonicalHashV1Result({ registrationHash: cut.registrationHash, ...witness })),
  )
  expect(
    Result.getOrThrow(
      derivePreparedAlphaBaselineSources({ ...cut, durableObservations: [{ ...witness, correct: false }] }),
    ),
  ).toEqual([])
  for (const malformed of [
    { ...witness, sourceAt: source.payload.acquisition.completedAt },
    { ...witness, witnessedAt: source.payload.acquisition.completedAt },
    { ...witness, witnessedAt: '2026-09-04T13:31:02.001Z' },
    { ...witness, sourceHash: 'f'.repeat(64) },
  ])
    expect(Result.isFailure(derivePreparedAlphaBaselineSources({ ...cut, durableObservations: [malformed] }))).toBe(
      true,
    )
  expect(
    Result.isFailure(derivePreparedAlphaBaselineSources({ ...cut, alphaBaselinePreparations: [source, source] })),
  ).toBe(true)
  expect(
    Result.isFailure(derivePreparedAlphaBaselineSources({ ...cut, durableObservations: [witness, witness] })),
  ).toBe(true)
  const scopeOverride = { ...witness, registrationHash: 'e'.repeat(64) }
  expect(
    Result.isFailure(
      derivePreparedAlphaBaselineSources({
        ...cut,
        durableObservations: [scopeOverride],
      }),
    ),
  ).toBe(true)
})
