import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Result, Schema } from 'effect'

import {
  FinalizedSnapshotProvenanceSchema,
  RunIdentitySchema,
  decodeEvaluationBounds,
  decodeFinalizedSnapshot,
  decodeRunIdentity,
  decodeRuntimeProvenance,
  makeRunIdentityResult,
  makeRuntimeProvenanceResult,
} from './contracts'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const expectFailure = async <A, E>(effect: Effect.Effect<A, E>): Promise<void> => {
  expect(Exit.isFailure(await Effect.runPromiseExit(effect))).toBe(true)
}

describe('current contracts', () => {
  const fixture = makeSnapshot()
  const snapshot = fixture.manifest.finalizedSnapshot
  const bounds = fixture.manifest.bounds

  test('accepts the current snapshot and bounds', async () => {
    const decodedSnapshot = await Effect.runPromise(decodeFinalizedSnapshot(snapshot))
    expect(decodedSnapshot).toEqual(snapshot)
    expect(Schema.encodeSync(FinalizedSnapshotProvenanceSchema)(decodedSnapshot)).toEqual(snapshot)
    expect(await Effect.runPromise(decodeEvaluationBounds(bounds))).toEqual(bounds)
  })

  test('rejects legacy versions, malformed snapshots, and unknown fields', async () => {
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, schemaVersion: 'bayn.finalized-snapshot.v2' }))
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, firstSession: '2025-02-30' }))
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, symbols: [...snapshot.symbols].reverse() }))
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, rowCount: snapshot.rowCount - 1 }))
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, futureField: true }))
    await expectFailure(decodeEvaluationBounds({ ...bounds, evaluationStart: '2016-01-01' }))
  })

  test('makes a deterministic identity bound to every material input', async () => {
    const material = {
      schemaVersion: 'bayn.run-identity.v1' as const,
      sourceRevision: 'c'.repeat(40),
      image: {
        repository: 'ghcr.io/proompteng/bayn',
        digest: `sha256:${'d'.repeat(64)}`,
      },
      strategy: {
        name: 'risk-balanced-trend' as const,
        behaviorHash: 'e'.repeat(64),
        parameters: fixtureProtocol,
      },
      finalizedSnapshot: snapshot,
      calendarVersion: snapshot.calendarVersion,
      bounds,
    }
    const baseline = Result.getOrThrow(makeRunIdentityResult(material))
    const reordered = Result.getOrThrow(
      makeRunIdentityResult({
        ...material,
        strategy: { ...material.strategy, parameters: { ...fixtureProtocol, universe: [...fixtureProtocol.universe] } },
      }),
    )

    expect(reordered.runId).toBe(baseline.runId)
    expect(await Effect.runPromise(decodeRunIdentity(baseline))).toEqual(baseline)
    expect(Schema.encodeSync(RunIdentitySchema)(baseline)).toEqual(baseline)
    expect(Result.getOrThrow(makeRunIdentityResult({ ...material, sourceRevision: 'f'.repeat(40) })).runId).not.toBe(
      baseline.runId,
    )
    expect(
      Result.getOrThrow(
        makeRunIdentityResult({
          ...material,
          strategy: { ...material.strategy, behaviorHash: '1'.repeat(64) },
        }),
      ).runId,
    ).not.toBe(baseline.runId)
    await expectFailure(decodeRunIdentity({ ...baseline, runId: '9'.repeat(64) }))
  })

  test('accepts current and immutable historical runtime provenance', async () => {
    const provenance = makeTestProvenance()
    expect(
      Result.getOrThrow(
        makeRuntimeProvenanceResult({
          sourceRevision: provenance.sourceRevision,
          image: provenance.image,
          strategy: provenance.strategy,
        }),
      ),
    ).toEqual(provenance)
    expect(await Effect.runPromise(decodeRuntimeProvenance(provenance))).toEqual(provenance)
    expect(provenance).toMatchObject({
      schemaVersion: 'bayn.runtime-provenance.v2',
      strategy: {
        name: 'risk-balanced-trend',
        parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
      },
      contractVersions: {
        inputManifest: 'bayn.input-manifest.v3',
        evaluation: 'bayn.evaluation.v6',
      },
    })
    expect(
      await Effect.runPromise(
        decodeRuntimeProvenance({
          ...provenance,
          strategy: {
            ...provenance.strategy,
            parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v2',
          },
        }),
      ),
    ).toMatchObject({
      strategy: { parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v2' },
    })
    await expectFailure(decodeRuntimeProvenance({ ...provenance, futureField: true }))
    expect(
      Effect.runPromise(
        decodeRuntimeProvenance({
          ...provenance,
          strategy: { ...provenance.strategy, name: 'tsmom', parameterSchemaVersion: 'bayn.tsmom.protocol.v2' },
        }),
      ),
    ).resolves.toMatchObject({ strategy: { name: 'tsmom', parameterSchemaVersion: 'bayn.tsmom.protocol.v2' } })
  })

  test('returns malformed runtime provenance as a typed construction failure', () => {
    const provenance = makeTestProvenance()
    const result = makeRuntimeProvenanceResult({
      sourceRevision: 'not-a-revision',
      image: provenance.image,
      strategy: provenance.strategy,
    } as never)

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        _tag: 'ContractSchemaInvalid',
        operation: 'runtime-provenance',
      })
    }
  })
})
