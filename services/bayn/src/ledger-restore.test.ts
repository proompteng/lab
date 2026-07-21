import { describe, expect, test } from 'bun:test'
import { ConfigProvider, Effect, Fiber, Option, Redacted } from 'effect'
import { TestClock } from 'effect/testing'

import type { EmbeddedBuildMetadata } from './build'
import { makeStrategyProtocolHash } from './contracts'
import { EvidenceStore, type EvidenceStoreService, type StoredEvaluationEvidence } from './db/evidence-store'
import { canonicalHashV1 } from './hash'
import { buildLedgerPlan, Journal, type JournalService, type LedgerInput } from './ledger'
import { loadRestoreConfig, restoreLedger, type RestoreConfig, type RestoreContract } from './ledger-restore'
import { makeQualificationResult } from './qualification'
import { evaluateTsmom, summarizeEvaluation } from './strategy'
import { makeTsmomStrategy } from './strategy-service'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const snapshot = makeSnapshot(800)
const provenance = makeTestProvenance()
const evaluation = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, provenance)
const strategy = makeTsmomStrategy(fixtureProtocol, provenance)
const sessionDates = [...new Set(snapshot.bars.map((bar) => bar.sessionDate))].sort()
const lock = strategy.prepareLock(snapshot.manifest, sessionDates, [])
const qualificationResult = makeQualificationResult(lock, evaluation.verdict, strategy.analyze(evaluation, []))
const plan = buildLedgerPlan(evaluation, 7_001)
const reconciliation = {
  runId: evaluation.runId,
  accountCount: plan.accounts.length,
  transferCount: plan.transfers.length,
  exact: true as const,
}

const stored: StoredEvaluationEvidence = {
  protocol: {
    protocolHash: makeStrategyProtocolHash(provenance.strategy),
    schemaVersion: fixtureProtocol.schemaVersion,
    strategyName: 'tsmom',
    behaviorHash: provenance.strategy.behaviorHash,
    parameterHash: provenance.strategy.parameterHash,
    parameters: fixtureProtocol,
  },
  run: {
    runId: evaluation.runId,
    protocolHash: evaluation.protocolHash,
    snapshotId: snapshot.manifest.finalizedSnapshot.snapshotId,
    evaluationSchemaVersion: evaluation.schemaVersion,
    sourceRevision: provenance.sourceRevision,
    imageRepository: provenance.image.repository,
    imageDigest: provenance.image.digest,
    strategyName: 'tsmom',
    initialCapitalMicros: evaluation.initialCapitalMicros,
    artifactCount: 17,
    eventCount: evaluation.events.length,
    gateCount: evaluation.verdict.gates.length,
  },
  artifacts: [
    {
      name: 'input-manifest',
      schemaVersion: snapshot.manifest.schemaVersion,
      contentHash: canonicalHashV1(snapshot.manifest),
      payload: snapshot.manifest,
    },
  ],
  events: evaluation.events.map((event, ordinal) => ({
    ordinal,
    id: event.id,
    kind: event.kind,
    contentHash: canonicalHashV1(event),
    payload: event,
  })),
  gates: [],
  statuses: [
    { status: 'WRITING', detail: {} },
    { status: 'COMPLETE', detail: { reconciliationExact: true, verdict: evaluation.verdict.status } },
  ],
}

const config: RestoreConfig = {
  runId: evaluation.runId,
  expectedAccountCount: reconciliation.accountCount,
  expectedTransferCount: reconciliation.transferCount,
  operationTimeoutMs: 1_000,
  build: {
    sourceRevision: 'd'.repeat(40),
    imageRepository: 'registry.ide-newton.ts.net/lab/bayn',
    imageDigest: `sha256:${'e'.repeat(64)}`,
  },
  postgres: {
    url: Redacted.make('postgresql://bayn:secret@postgres.test:5432/bayn'),
    tls: true,
    caPath: '/var/run/secrets/bayn/postgres/ca.crt',
  },
  tigerBeetle: {
    clusterId: 222397790944575595450310052784555675227n,
    replicaAddresses: [
      'bayn-tigerbeetle-0.bayn-tigerbeetle-headless.bayn.svc.cluster.local:3000',
      'bayn-tigerbeetle-1.bayn-tigerbeetle-headless.bayn.svc.cluster.local:3000',
      'bayn-tigerbeetle-2.bayn-tigerbeetle-headless.bayn.svc.cluster.local:3000',
    ],
    ledger: 7_001,
  },
}

const restoreBuild: EmbeddedBuildMetadata = {
  sourceRevision: config.build.sourceRevision,
  imageRepository: config.build.imageRepository,
  strategyBehaviorHash: 'f'.repeat(64),
}
const restoreContract: RestoreContract = {
  runId: config.runId,
  expectedAccountCount: config.expectedAccountCount,
  expectedTransferCount: config.expectedTransferCount,
  target: config.tigerBeetle,
}
const restoreEnvironment = new Map([
  ['BAYN_LEDGER_RESTORE_RUN_ID', config.runId],
  ['BAYN_LEDGER_RESTORE_EXPECTED_ACCOUNT_COUNT', String(config.expectedAccountCount)],
  ['BAYN_LEDGER_RESTORE_EXPECTED_TRANSFER_COUNT', String(config.expectedTransferCount)],
  ['BAYN_OPERATION_TIMEOUT_MS', String(config.operationTimeoutMs)],
  ['BAYN_CODE_REVISION', config.build.sourceRevision],
  ['BAYN_IMAGE_REPOSITORY', config.build.imageRepository],
  ['BAYN_IMAGE_DIGEST', config.build.imageDigest],
  ['BAYN_POSTGRES_URL', Redacted.value(config.postgres.url)],
  ['BAYN_TIGERBEETLE_CLUSTER_ID', config.tigerBeetle.clusterId.toString()],
  ['BAYN_TIGERBEETLE_ADDRESSES', config.tigerBeetle.replicaAddresses.join(',')],
  ['BAYN_TIGERBEETLE_LEDGER', String(config.tigerBeetle.ledger)],
])

const provideEnvironment = <A, E>(effect: Effect.Effect<A, E>, environment: Map<string, string>) =>
  effect.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(Object.fromEntries(environment))),
  )

const evidenceStore = (qualification = true): EvidenceStoreService => ({
  check: Effect.void,
  persist: () => Effect.die('restore must not persist'),
  read: (runId) => Effect.succeed(runId === evaluation.runId ? Option.some(stored) : Option.none()),
  readArtifactItems: () => Effect.die('restore must not page artifacts'),
  recover: (runId, recoveredProvenance) => {
    expect(runId).toBe(evaluation.runId)
    expect(recoveredProvenance).toEqual(provenance)
    return Effect.succeed(
      Option.some({
        evaluation: summarizeEvaluation(evaluation),
        reconciliation,
        persistence: {
          runId: evaluation.runId,
          deduplicated: true,
          artifactCount: 17,
          eventCount: evaluation.events.length,
          gateCount: evaluation.verdict.gates.length,
        },
      }),
    )
  },
  listPriorTrials: Effect.die('restore must not list trials'),
  openQualification: () => Effect.die('restore must not open a qualification'),
  readQualification: () =>
    Effect.succeed(
      qualification ? Option.some({ state: 'TERMINAL', lock, result: qualificationResult }) : Option.none(),
    ),
})

const runRestore = (restoreConfig: RestoreConfig, store: EvidenceStoreService, journal: JournalService) =>
  restoreLedger(restoreConfig).pipe(
    Effect.provideService(EvidenceStore, store),
    Effect.provideService(Journal, journal),
  )

describe('dedicated TigerBeetle restore', () => {
  test('loads only the strict operator configuration', async () => {
    const loaded = await Effect.runPromise(
      provideEnvironment(loadRestoreConfig(restoreBuild, restoreContract), restoreEnvironment),
    )

    expect(loaded).toEqual(config)
  })

  test('requires embedded provenance, PostgreSQL TLS, and a non-zero u128 cluster ID', async () => {
    const missingBuild = await Effect.runPromise(
      Effect.flip(provideEnvironment(loadRestoreConfig(undefined, restoreContract), restoreEnvironment)),
    )
    expect(missingBuild).toMatchObject({ component: 'config', operation: 'load-ledger-restore' })

    for (const [name, value] of [
      ['BAYN_POSTGRES_TLS', 'false'],
      ['BAYN_TIGERBEETLE_CLUSTER_ID', '0'],
      ['BAYN_TIGERBEETLE_CLUSTER_ID', (1n << 128n).toString()],
    ] as const) {
      const invalid = new Map(restoreEnvironment)
      invalid.set(name, value)
      const error = await Effect.runPromise(
        Effect.flip(provideEnvironment(loadRestoreConfig(restoreBuild, restoreContract), invalid)),
      )
      expect(error).toMatchObject({ component: 'config', operation: 'load-ledger-restore' })
    }
  })

  test('rejects drift from the pinned run, counts, target cluster, replica order, or ledger', async () => {
    for (const [name, value] of [
      ['BAYN_LEDGER_RESTORE_RUN_ID', '1'.repeat(64)],
      ['BAYN_LEDGER_RESTORE_EXPECTED_ACCOUNT_COUNT', String(config.expectedAccountCount + 1)],
      ['BAYN_LEDGER_RESTORE_EXPECTED_TRANSFER_COUNT', String(config.expectedTransferCount + 1)],
      ['BAYN_TIGERBEETLE_CLUSTER_ID', String(config.tigerBeetle.clusterId + 1n)],
      ['BAYN_TIGERBEETLE_ADDRESSES', [...config.tigerBeetle.replicaAddresses].reverse().join(',')],
      ['BAYN_TIGERBEETLE_LEDGER', String(config.tigerBeetle.ledger + 1)],
    ] as const) {
      const drifted = new Map(restoreEnvironment)
      drifted.set(name, value)
      const error = await Effect.runPromise(
        Effect.flip(provideEnvironment(loadRestoreConfig(restoreBuild, restoreContract), drifted)),
      )
      expect(error.message).toContain('pinned one-shot contract')
    }
  })

  test('restores one terminal run and emits a deterministic receipt', async () => {
    const inputs: LedgerInput[] = []
    const journal: JournalService = {
      check: Effect.die('restore must not use a connectivity-only check'),
      checkRun: () => Effect.die('restore must use exact create-and-verify'),
      journalAndReconcile: (input) => {
        inputs.push(input)
        return Effect.succeed(reconciliation)
      },
    }

    const first = await Effect.runPromise(runRestore(config, evidenceStore(), journal))
    const second = await Effect.runPromise(runRestore(config, evidenceStore(), journal))

    expect(inputs).toEqual([
      {
        runId: evaluation.runId,
        initialCapitalMicros: evaluation.initialCapitalMicros,
        inputManifest: evaluation.inputManifest,
        events: evaluation.events,
      },
      {
        runId: evaluation.runId,
        initialCapitalMicros: evaluation.initialCapitalMicros,
        inputManifest: evaluation.inputManifest,
        events: evaluation.events,
      },
    ])
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      schemaVersion: 'bayn.ledger-restore-receipt.v1',
      source: {
        revision: provenance.sourceRevision,
        image: provenance.image,
      },
      restore: {
        revision: config.build.sourceRevision,
        image: {
          repository: config.build.imageRepository,
          digest: config.build.imageDigest,
        },
      },
      target: {
        clusterId: config.tigerBeetle.clusterId.toString(),
        ledger: 7_001,
      },
      runId: evaluation.runId,
      qualification: qualificationResult.verdict,
      accountCount: reconciliation.accountCount,
      transferCount: reconciliation.transferCount,
      exact: true,
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  test('rejects a run without a terminal qualification before touching TigerBeetle', async () => {
    let writes = 0
    const journal: JournalService = {
      check: Effect.void,
      checkRun: () => Effect.void,
      journalAndReconcile: () => {
        writes += 1
        return Effect.succeed(reconciliation)
      },
    }

    const error = await Effect.runPromise(Effect.flip(runRestore(config, evidenceStore(false), journal)))
    expect(error.message).toContain('has no terminal qualification')
    expect(writes).toBe(0)
  })

  test('rejects a missing pinned run before touching TigerBeetle', async () => {
    let writes = 0
    const missing: EvidenceStoreService = {
      ...evidenceStore(),
      read: () => Effect.succeed(Option.none()),
    }
    const journal: JournalService = {
      check: Effect.void,
      checkRun: () => Effect.void,
      journalAndReconcile: () => {
        writes += 1
        return Effect.succeed(reconciliation)
      },
    }

    const error = await Effect.runPromise(Effect.flip(runRestore(config, missing, journal)))
    expect(error.message).toContain(`run ${config.runId} is missing`)
    expect(writes).toBe(0)
  })

  test('rejects malformed PostgreSQL evidence before touching TigerBeetle', async () => {
    let writes = 0
    const malformed: StoredEvaluationEvidence = {
      ...stored,
      artifacts: [{ ...stored.artifacts[0], payload: { schemaVersion: 'malformed' } }],
    }
    const store: EvidenceStoreService = {
      ...evidenceStore(),
      read: () => Effect.succeed(Option.some(malformed)),
    }
    const journal: JournalService = {
      check: Effect.void,
      checkRun: () => Effect.void,
      journalAndReconcile: () => {
        writes += 1
        return Effect.succeed(reconciliation)
      },
    }

    const error = await Effect.runPromise(Effect.flip(runRestore(config, store, journal)))
    expect(error.message).toContain('stored ledger input is invalid')
    expect(writes).toBe(0)
  })

  test('rejects precommitted count drift before touching TigerBeetle', async () => {
    let writes = 0
    const journal: JournalService = {
      check: Effect.void,
      checkRun: () => Effect.void,
      journalAndReconcile: () => {
        writes += 1
        return Effect.succeed(reconciliation)
      },
    }
    const drifted = { ...config, expectedTransferCount: config.expectedTransferCount + 1 }

    const error = await Effect.runPromise(Effect.flip(runRestore(drifted, evidenceStore(), journal)))
    expect(error.message).toContain('precommitted ledger counts diverged')
    expect(writes).toBe(0)
  })

  test('rejects a target reconciliation that differs from immutable evidence', async () => {
    const journal: JournalService = {
      check: Effect.void,
      checkRun: () => Effect.void,
      journalAndReconcile: () => Effect.succeed({ ...reconciliation, transferCount: reconciliation.transferCount - 1 }),
    }

    const error = await Effect.runPromise(Effect.flip(runRestore(config, evidenceStore(), journal)))
    expect(error.message).toContain('target reconciliation differs')
  })

  test('interrupts an unknown TigerBeetle outcome and fails within the operator deadline', async () => {
    let interrupted = false
    const journal: JournalService = {
      check: Effect.void,
      checkRun: () => Effect.void,
      journalAndReconcile: () =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true)))),
    }
    const timed = { ...config, operationTimeoutMs: 10 }
    const program = Effect.gen(function* () {
      const fiber = yield* Effect.flip(runRestore(timed, evidenceStore(), journal)).pipe(
        Effect.forkChild({ startImmediately: true }),
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust(timed.operationTimeoutMs)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()))

    const error = await Effect.runPromise(program)
    expect(error.message).toContain('journal restore-and-reconcile timed out after 10ms')
    expect(interrupted).toBe(true)
  })
})
