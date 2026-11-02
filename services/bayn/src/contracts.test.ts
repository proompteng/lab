import { strictParseOptions } from './schemas'
import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Result, Schema } from 'effect'

import {
  FinalizedSnapshotProvenanceSchema,
  RunIdentitySchema,
  makeRunIdentityResult,
  makeRuntimeProvenanceResult,
  EvaluationBoundsSchema,
  RuntimeProvenanceSchema,
} from './contracts'
import { makePersistedSnapshotFixture } from './testing/persisted-snapshot-fixture'
import { fixtureProtocol, provenance } from './testing/runtime-fixtures'

const expectFailure = async <A, E>(effect: Effect.Effect<A, E>): Promise<void> => {
  expect(Exit.isFailure(await Effect.runPromiseExit(effect))).toBe(true)
}

describe('runtime contracts', () => {
  const manifest = makePersistedSnapshotFixture()
  const snapshot = manifest.finalizedSnapshot

  test('accepts an exact persisted snapshot and rejects malformed identity material', async () => {
    expect(
      await Effect.runPromise(
        Schema.decodeUnknownEffect(FinalizedSnapshotProvenanceSchema, strictParseOptions)(snapshot),
      ),
    ).toEqual(snapshot)
    expect(Schema.encodeSync(FinalizedSnapshotProvenanceSchema)(snapshot)).toEqual(snapshot)
    expect(
      await Effect.runPromise(Schema.decodeUnknownEffect(EvaluationBoundsSchema, strictParseOptions)(manifest.bounds)),
    ).toEqual(manifest.bounds)

    await expectFailure(
      Schema.decodeUnknownEffect(
        FinalizedSnapshotProvenanceSchema,
        strictParseOptions,
      )({ ...snapshot, firstSession: '2026-08-30' }),
    )
    await expectFailure(
      Schema.decodeUnknownEffect(
        FinalizedSnapshotProvenanceSchema,
        strictParseOptions,
      )({ ...snapshot, symbols: [...snapshot.symbols].reverse() }),
    )
    await expectFailure(
      Schema.decodeUnknownEffect(
        FinalizedSnapshotProvenanceSchema,
        strictParseOptions,
      )({ ...snapshot, rowCount: snapshot.rowCount - 1 }),
    )
    await expectFailure(
      Schema.decodeUnknownEffect(
        FinalizedSnapshotProvenanceSchema,
        strictParseOptions,
      )({ ...snapshot, futureField: true }),
    )
  })

  test('binds a run identity to the active intraday strategy, source, image, and snapshot', async () => {
    const material = {
      schemaVersion: 'bayn.run-identity.v1' as const,
      sourceRevision: provenance.sourceRevision,
      image: provenance.image,
      strategy: {
        name: provenance.strategy.name,
        behaviorHash: provenance.strategy.behaviorHash,
        parameters: fixtureProtocol,
      },
      finalizedSnapshot: snapshot,
      calendarVersion: snapshot.calendarVersion,
      bounds: manifest.bounds,
    }
    const baseline = Result.getOrThrow(makeRunIdentityResult(material))
    const replay = Result.getOrThrow(makeRunIdentityResult(structuredClone(material)))

    expect(replay).toEqual(baseline)
    expect(
      await Effect.runPromise(Schema.decodeUnknownEffect(RunIdentitySchema, strictParseOptions)(baseline)),
    ).toEqual(baseline)
    expect(Schema.encodeSync(RunIdentitySchema)(baseline)).toEqual(baseline)
    expect(Result.getOrThrow(makeRunIdentityResult({ ...material, sourceRevision: 'f'.repeat(40) })).runId).not.toBe(
      baseline.runId,
    )
    await expectFailure(
      Schema.decodeUnknownEffect(RunIdentitySchema, strictParseOptions)({ ...baseline, runId: '9'.repeat(64) }),
    )
  })

  test('accepts only well-formed runtime provenance at the public boundary', async () => {
    expect(
      Result.getOrThrow(
        makeRuntimeProvenanceResult({
          sourceRevision: provenance.sourceRevision,
          image: provenance.image,
          strategy: provenance.strategy,
        }),
      ),
    ).toEqual(provenance)
    expect(
      await Effect.runPromise(Schema.decodeUnknownEffect(RuntimeProvenanceSchema, strictParseOptions)(provenance)),
    ).toEqual(provenance)
    await expectFailure(
      Schema.decodeUnknownEffect(RuntimeProvenanceSchema, strictParseOptions)({ ...provenance, futureField: true }),
    )

    const invalid = makeRuntimeProvenanceResult({
      sourceRevision: 'not-a-revision',
      image: provenance.image,
      strategy: provenance.strategy,
    } as never)
    expect(invalid).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'ContractSchemaInvalid', operation: 'runtime-provenance' },
    })
  })
})
