import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Schema } from 'effect'

import {
  FinalizedSnapshotProvenanceSchema,
  RunIdentitySchema,
  decodeEvaluationBounds,
  decodeFinalizedSnapshot,
  decodeRunIdentity,
  decodeRuntimeProvenance,
  makeRunIdentity,
} from './contracts'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const expectFailure = async (effect: Effect.Effect<unknown, unknown>): Promise<void> => {
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
    const baseline = makeRunIdentity(material)
    const reordered = makeRunIdentity({
      ...material,
      strategy: { ...material.strategy, parameters: { ...fixtureProtocol, universe: [...fixtureProtocol.universe] } },
    })

    expect(reordered.runId).toBe(baseline.runId)
    expect(await Effect.runPromise(decodeRunIdentity(baseline))).toEqual(baseline)
    expect(Schema.encodeSync(RunIdentitySchema)(baseline)).toEqual(baseline)
    expect(makeRunIdentity({ ...material, sourceRevision: 'f'.repeat(40) }).runId).not.toBe(baseline.runId)
    expect(
      makeRunIdentity({ ...material, strategy: { ...material.strategy, behaviorHash: '1'.repeat(64) } }).runId,
    ).not.toBe(baseline.runId)
    await expectFailure(decodeRunIdentity({ ...baseline, runId: '9'.repeat(64) }))
  })

  test('accepts only current runtime provenance', async () => {
    const provenance = makeTestProvenance()
    expect(await Effect.runPromise(decodeRuntimeProvenance(provenance))).toEqual(provenance)
    expect(provenance).toMatchObject({
      schemaVersion: 'bayn.runtime-provenance.v2',
      strategy: {
        name: 'risk-balanced-trend',
        parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v2',
      },
      contractVersions: {
        inputManifest: 'bayn.input-manifest.v3',
        evaluation: 'bayn.evaluation.v6',
      },
    })
    await expectFailure(decodeRuntimeProvenance({ ...provenance, futureField: true }))
    await expectFailure(
      decodeRuntimeProvenance({
        ...provenance,
        strategy: { ...provenance.strategy, name: 'tsmom', parameterSchemaVersion: 'bayn.tsmom.protocol.v2' },
      }),
    )
  })
})
