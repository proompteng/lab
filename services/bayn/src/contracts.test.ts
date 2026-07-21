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
  makeRuntimeProvenance,
} from './contracts'
import { ContractVersion, DataFeed, DataSource, PriceAdjustment, PublicationSchema } from './types'

const sha = (character: string): string => character.repeat(64)

const snapshot = {
  schemaVersion: 'bayn.finalized-snapshot.v2' as const,
  snapshotId: sha('a'),
  publicationId: sha('b'),
  publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV1,
  source: DataSource.Alpaca,
  sourceFeed: DataFeed.Sip,
  adjustment: PriceAdjustment.All,
  calendarVersion: 'XNYS-2025a',
  publisherSourceRevision: '1'.repeat(40),
  publisherImage: {
    repository: 'registry.ide-newton.ts.net/lab/signal-publisher',
    digest: `sha256:${sha('2')}`,
  },
  finalizedAt: '2026-01-01T01:00:00.000Z',
  requestedStart: '2020-01-02',
  firstSession: '2020-01-02',
  lastSession: '2025-12-31',
  asOfSession: '2025-12-31',
  symbols: ['EEM', 'SPY'],
  rowCount: 3_020,
  sessionCount: 1_510,
  contentHash: sha('3'),
  sessionsContentHash: sha('4'),
} as const

const bounds = {
  schemaVersion: 'bayn.evaluation-bounds.v1' as const,
  dataStart: '2020-01-02',
  dataEnd: '2025-12-31',
  lookbackStart: '2020-01-02',
  evaluationStart: '2021-01-04',
  evaluationEnd: '2025-12-31',
} as const

const material = {
  schemaVersion: 'bayn.run-identity.v1' as const,
  sourceRevision: 'c'.repeat(40),
  image: {
    repository: 'ghcr.io/proompteng/bayn',
    digest: `sha256:${sha('d')}`,
  },
  strategy: {
    name: 'tsmom',
    behaviorHash: sha('e'),
    parameters: {
      lookbacks: [21, 63, 126, 252],
      executionModel: { slippageBps: 5 },
    },
  },
  finalizedSnapshot: snapshot,
  calendarVersion: snapshot.calendarVersion,
  bounds,
} as const

const expectFailure = async (effect: Effect.Effect<unknown, unknown>): Promise<void> => {
  expect(Exit.isFailure(await Effect.runPromiseExit(effect))).toBe(true)
}

describe('Bayn contract decoding', () => {
  test('accepts the versioned valid fixtures', async () => {
    const decodedSnapshot = await Effect.runPromise(decodeFinalizedSnapshot(snapshot))
    expect(decodedSnapshot).toEqual(snapshot)
    expect(Schema.encodeSync(FinalizedSnapshotProvenanceSchema)(decodedSnapshot)).toEqual(snapshot)
    expect(await Effect.runPromise(decodeEvaluationBounds(bounds))).toEqual(bounds)
  })

  test('rejects malformed dates, duplicate symbols, and invalid bounds', async () => {
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, firstSession: '2025-02-30' }))
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, symbols: ['SPY', 'SPY'] }))
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, symbols: ['SPY', 'EEM'] }))
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, rowCount: snapshot.rowCount - 1 }))
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, requestedStart: '2020-01-03' }))
    await expectFailure(decodeEvaluationBounds({ ...bounds, evaluationStart: '2019-12-31' }))
    await expectFailure(decodeEvaluationBounds({ ...bounds, evaluationEnd: '2026-01-02' }))
  })

  test('rejects unknown versions and forward-incompatible fields', async () => {
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, schemaVersion: 'bayn.finalized-snapshot.v1' }))
    await expectFailure(decodeFinalizedSnapshot({ ...snapshot, futureField: true }))
  })
})

describe('Bayn run identity', () => {
  test('is stable across object insertion order', async () => {
    const baseline = makeRunIdentity(material)
    const reordered = makeRunIdentity({
      ...material,
      strategy: {
        ...material.strategy,
        parameters: {
          executionModel: { slippageBps: 5 },
          lookbacks: [21, 63, 126, 252],
        },
      },
    })

    expect(reordered.runId).toBe(baseline.runId)
    expect(await Effect.runPromise(decodeRunIdentity(baseline))).toEqual(baseline)
    expect(Schema.encodeSync(RunIdentitySchema)(baseline)).toEqual(baseline)
  })

  test('binds every required identity component', () => {
    const baseline = makeRunIdentity(material).runId
    const variants = [
      { ...material, sourceRevision: 'f'.repeat(40) },
      { ...material, image: { ...material.image, digest: `sha256:${sha('1')}` } },
      { ...material, strategy: { ...material.strategy, behaviorHash: sha('2') } },
      {
        ...material,
        strategy: { ...material.strategy, parameters: { lookbacks: [21], executionModel: { slippageBps: 5 } } },
      },
      { ...material, finalizedSnapshot: { ...snapshot, contentHash: sha('7') } },
      { ...material, bounds: { ...bounds, evaluationEnd: '2025-12-30' } },
      {
        ...material,
        finalizedSnapshot: { ...snapshot, calendarVersion: 'XNYS-2025b' },
        calendarVersion: 'XNYS-2025b',
      },
    ] as const

    for (const variant of variants) expect(makeRunIdentity(variant).runId).not.toBe(baseline)
  })

  test('rejects snapshot, calendar, bound, and persisted-hash mismatches', async () => {
    expect(() => makeRunIdentity({ ...material, calendarVersion: 'XNYS-2025b' })).toThrow()
    expect(() =>
      makeRunIdentity({
        ...material,
        bounds: { ...bounds, dataEnd: '2026-01-02', evaluationEnd: '2026-01-02' },
      }),
    ).toThrow()

    const identity = makeRunIdentity(material)
    await expectFailure(decodeRunIdentity({ ...identity, runId: sha('9') }))
    await expectFailure(decodeRunIdentity({ ...identity, image: { ...identity.image, futureField: true } }))
    expect(() =>
      makeRunIdentity({
        ...material,
        strategy: { ...material.strategy, parameters: { unsupported: undefined } },
      }),
    ).toThrow()
  })
})

describe('Bayn runtime provenance', () => {
  test('binds deploy identity, compiled behavior, parameters, and contract versions', async () => {
    const provenance = makeRuntimeProvenance({
      sourceRevision: 'c'.repeat(40),
      image: {
        repository: 'registry.ide-newton.ts.net/lab/bayn',
        digest: `sha256:${sha('d')}`,
      },
      strategy: {
        name: 'tsmom',
        behaviorHash: sha('e'),
        parameterHash: sha('f'),
        parameterSchemaVersion: 'bayn.tsmom.protocol.v2',
      },
    })

    expect(provenance).toMatchObject({
      schemaVersion: 'bayn.runtime-provenance.v2',
      contractVersions: {
        runtimeProvenance: 'bayn.runtime-provenance.v2',
        inputManifest: 'bayn.input-manifest.v2',
        evaluation: 'bayn.evaluation.v4',
      },
    })
    expect(await Effect.runPromise(decodeRuntimeProvenance(provenance))).toEqual(provenance)
    await expectFailure(decodeRuntimeProvenance({ ...provenance, futureField: true }))
    await expectFailure(decodeRuntimeProvenance({ ...provenance, schemaVersion: 'bayn.runtime-provenance.v1' }))

    const candidate = makeRuntimeProvenance({
      sourceRevision: provenance.sourceRevision,
      image: provenance.image,
      strategy: {
        name: 'risk-balanced-trend',
        behaviorHash: sha('1'),
        parameterHash: sha('2'),
        parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v2',
      },
    })
    expect(candidate.contractVersions.inputManifest).toBe('bayn.input-manifest.v3')
    expect(candidate.contractVersions.evaluation).toBe(ContractVersion.RiskBalancedTrendEvaluation)
    await expectFailure(
      decodeRuntimeProvenance({
        ...provenance,
        contractVersions: {
          ...provenance.contractVersions,
          evaluation: ContractVersion.RiskBalancedTrendEvaluation,
        },
      }),
    )
    await expectFailure(
      decodeRuntimeProvenance({
        ...candidate,
        contractVersions: { ...candidate.contractVersions, evaluation: ContractVersion.Evaluation },
      }),
    )
    expect(() =>
      makeRuntimeProvenance({
        sourceRevision: provenance.sourceRevision,
        image: provenance.image,
        strategy: { ...provenance.strategy, name: 'unknown' },
      }),
    ).toThrow('unsupported compiled strategy')
  })
})
