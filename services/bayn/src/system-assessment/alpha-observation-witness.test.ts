import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import { decodeJevProtocol, defaultJevProtocolDocument } from '../jev/protocol'
import { makeOwnedIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import {
  makeAlphaStreamingSnapshot,
  makeFlatAlphaPortfolio,
  makeTestTrailingBaseline,
} from '../strategy/intraday-alpha/test-support'
import {
  AlphaObservationWitnessSchema,
  deriveAlphaBaselineSources,
  earliestAlphaObservationWitness,
} from './alpha-observation-witness'
import { emptySourceCutFixture } from './source-cut.test-support'
import { StrategyBoundSystemSourceCutSchema } from './source-cut'

const market = makeAlphaStreamingSnapshot({ minutesFromOpen: 121, profiles: {} })
const observed = Result.getOrThrow(
  makeOwnedIntradayAlphaObservation({
    cycleId: sha256('witnessed alpha cycle'),
    authorityGenerationHash: sha256('witnessed alpha generation'),
    protocol: Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument)),
    portfolio: makeFlatAlphaPortfolio(market.observedAt),
    trailingBaseline: makeTestTrailingBaseline(),
    snapshot: market.snapshot,
  }),
)
const at = (delay: number) => new Date(Date.parse(market.observedAt) + delay).toISOString()
const retained = emptySourceCutFixture().cut
const fixture = () =>
  Schema.decodeUnknownSync(StrategyBoundSystemSourceCutSchema)({
    ...retained,
    schemaVersion: 'bayn.system-source-cut.v5',
    asOf: at(5000),
    alphaObservations: [{ contentHash: observed.contentHash, payload: observed.payload }],
    durableObservations: [
      {
        kind: 'ALPHA_OBSERVATION',
        sourceHash: observed.contentHash,
        sourceAt: market.observedAt,
        witnessedAt: at(1000),
        correct: true,
      },
    ],
  })

test('alpha baseline availability and source hash bind the complete later durable witness', () => {
  const cut = fixture()
  const expected = Schema.decodeUnknownSync(AlphaObservationWitnessSchema)({
    registrationHash: cut.registrationHash,
    ...cut.durableObservations[0],
  })
  expect(Result.getOrThrow(earliestAlphaObservationWitness(cut, observed.contentHash))).toEqual(expected)
  expect(Result.getOrThrow(deriveAlphaBaselineSources(cut))).toEqual([
    {
      observationHash: observed.contentHash,
      payload: observed.payload,
      availableAt: at(1000),
      witnessSourceHash: Result.getOrThrow(canonicalHashV1Result(expected)),
    },
  ])
  const anotherScope = { ...cut, registrationHash: sha256('different registration') }
  expect(Result.getOrThrow(deriveAlphaBaselineSources(anotherScope))[0]?.witnessSourceHash).not.toBe(
    Result.getOrThrow(deriveAlphaBaselineSources(cut))[0]?.witnessSourceHash,
  )
})

test('an unwitnessed, incorrect or differently typed observation never gains availability', () => {
  const cut = fixture()
  expect(Result.getOrThrow(deriveAlphaBaselineSources({ ...cut, durableObservations: [] }))).toEqual([])
  expect(
    Result.getOrThrow(earliestAlphaObservationWitness({ ...cut, durableObservations: [] }, observed.contentHash)),
  ).toBeNull()
  for (const change of [{ correct: false }, { kind: 'BATCH' as const }]) {
    const altered = { ...cut, durableObservations: cut.durableObservations.map((row) => ({ ...row, ...change })) }
    expect(Result.getOrThrow(deriveAlphaBaselineSources(altered))).toEqual([])
  }
  expect(Result.getOrThrow(deriveAlphaBaselineSources(retained))).toEqual([])
  expect(Result.getOrThrow(earliestAlphaObservationWitness(retained, observed.contentHash))).toBeNull()
})

test('source-time mismatch, future witnesses and premature availability fail closed', () => {
  const cut = fixture()
  for (const change of [{ sourceAt: at(-1) }, { witnessedAt: at(-1) }, { witnessedAt: at(5001) }]) {
    const altered = { ...cut, durableObservations: cut.durableObservations.map((row) => ({ ...row, ...change })) }
    expect(Result.isFailure(earliestAlphaObservationWitness(altered, observed.contentHash))).toBe(true)
    expect(Result.isFailure(deriveAlphaBaselineSources(altered))).toBe(true)
  }
  expect(Result.isFailure(deriveAlphaBaselineSources({ ...cut, asOf: at(-1) }))).toBe(true)
})

test('full observation reproduction rejects hash substitution, altered bars and noncausal baselines', () => {
  const cut = fixture()
  const changedBaseline = {
    ...observed.payload,
    trailingBaseline: {
      ...observed.payload.trailingBaseline,
      latestPriorSessionDate: observed.payload.trailingBaseline.sessionDate,
    },
  }
  for (const source of [
    { contentHash: sha256('substituted observation'), payload: observed.payload },
    {
      contentHash: observed.contentHash,
      payload: { ...observed.payload, rows: { ...observed.payload.rows, bars: [] } },
    },
    { contentHash: Result.getOrThrow(canonicalHashV1Result(changedBaseline)), payload: changedBaseline },
  ])
    expect(Result.isFailure(deriveAlphaBaselineSources({ ...cut, alphaObservations: [source] }))).toBe(true)
})

test('duplicate payload identities and witnesses without retained payloads fail closed', () => {
  const cut = fixture()
  const duplicate = { ...cut, alphaObservations: [...cut.alphaObservations, ...cut.alphaObservations] }
  expect(Result.isFailure(deriveAlphaBaselineSources(duplicate))).toBe(true)
  expect(Result.isFailure(earliestAlphaObservationWitness(duplicate, observed.contentHash))).toBe(true)
  const missing = { ...cut, alphaObservations: [] }
  expect(Result.isFailure(deriveAlphaBaselineSources(missing))).toBe(true)
  expect(Result.isFailure(earliestAlphaObservationWitness(missing, observed.contentHash))).toBe(true)
})
