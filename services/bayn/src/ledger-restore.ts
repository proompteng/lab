import { Config, Effect, Option, Redacted, Schema, SchemaTransformation } from 'effect'

import { EmbeddedBuildMetadataSchema, embeddedBuildMetadata, type EmbeddedBuildMetadata } from './build'
import { makeRuntimeProvenance, Sha256Schema } from './contracts'
import { EvidenceStore, type StoredEvaluationEvidence } from './db/evidence-store'
import { decodeEvaluationEvents, decodeInputManifestArtifact } from './evidence-contracts'
import { operationalError, type OperationalError } from './errors'
import { canonicalHashV1 } from './hash'
import { buildLedgerPlan, hashLedgerPlan, Journal, type LedgerInput } from './ledger'

export interface RestoreConfig {
  readonly runId: string
  readonly expectedAccountCount: number
  readonly expectedTransferCount: number
  readonly operationTimeoutMs: number
  readonly build: {
    readonly sourceRevision: string
    readonly imageRepository: string
    readonly imageDigest: string
  }
  readonly postgres: {
    readonly url: Redacted.Redacted<string>
    readonly tls: boolean
    readonly caPath: string
  }
  readonly tigerBeetle: {
    readonly clusterId: bigint
    readonly replicaAddresses: readonly string[]
    readonly ledger: number
  }
}

export interface RestoreContract {
  readonly runId: string
  readonly expectedAccountCount: number
  readonly expectedTransferCount: number
  readonly target: {
    readonly clusterId: bigint
    readonly replicaAddresses: readonly string[]
    readonly ledger: number
  }
}

export const restoreContract: RestoreContract = {
  runId: '42d8bbfaf1a2ce7759b2283384e8f41298fe3a354ba7c0e1756bb8a3e64af177',
  expectedAccountCount: 14,
  expectedTransferCount: 906,
  target: {
    clusterId: 222397790944575595450310052784555675227n,
    replicaAddresses: [
      'bayn-tigerbeetle-0.bayn-tigerbeetle-headless.bayn.svc.cluster.local:3000',
      'bayn-tigerbeetle-1.bayn-tigerbeetle-headless.bayn.svc.cluster.local:3000',
      'bayn-tigerbeetle-2.bayn-tigerbeetle-headless.bayn.svc.cluster.local:3000',
    ],
    ledger: 7_001,
  },
}

export interface RestoreReceipt {
  readonly schemaVersion: 'bayn.ledger-restore-receipt.v1'
  readonly source: {
    readonly revision: string
    readonly image: {
      readonly repository: string
      readonly digest: string
    }
  }
  readonly restore: {
    readonly revision: string
    readonly image: {
      readonly repository: string
      readonly digest: string
    }
  }
  readonly target: {
    readonly clusterId: string
    readonly ledger: number
  }
  readonly runId: string
  readonly qualification: 'QUALIFIED' | 'REJECTED'
  readonly accountCount: number
  readonly transferCount: number
  readonly exact: true
  readonly planHash: string
}

const NonEmptyString = Schema.Trim.check(Schema.isMinLength(1))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const SourceRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const ImageRepository = Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
const ReplicaAddresses = Schema.Trim.pipe(
  Schema.decodeTo(
    Schema.Array(NonEmptyString).check(Schema.isMinLength(1)),
    SchemaTransformation.transform<readonly string[], string>({
      decode: (value) =>
        value
          .split(',')
          .map((address) => address.trim())
          .filter(Boolean),
      encode: (addresses) => addresses.join(','),
    }),
  ),
)

const restoreConfig = Config.all({
  runId: Config.schema(Sha256Schema, 'BAYN_LEDGER_RESTORE_RUN_ID'),
  expectedAccountCount: Config.schema(PositiveInteger, 'BAYN_LEDGER_RESTORE_EXPECTED_ACCOUNT_COUNT'),
  expectedTransferCount: Config.schema(PositiveInteger, 'BAYN_LEDGER_RESTORE_EXPECTED_TRANSFER_COUNT'),
  operationTimeoutMs: Config.schema(PositiveInteger, 'BAYN_OPERATION_TIMEOUT_MS').pipe(Config.withDefault(30_000)),
  sourceRevision: Config.schema(SourceRevision, 'BAYN_CODE_REVISION'),
  imageRepository: Config.schema(ImageRepository, 'BAYN_IMAGE_REPOSITORY'),
  imageDigest: Config.schema(ImageDigest, 'BAYN_IMAGE_DIGEST'),
  postgresUrl: Config.redacted('BAYN_POSTGRES_URL'),
  postgresTls: Config.boolean('BAYN_POSTGRES_TLS').pipe(Config.withDefault(true)),
  postgresCaPath: Config.schema(NonEmptyString, 'BAYN_POSTGRES_CA_PATH').pipe(
    Config.withDefault('/var/run/secrets/bayn/postgres/ca.crt'),
  ),
  tigerBeetleClusterId: Config.schema(Schema.BigIntFromString, 'BAYN_TIGERBEETLE_CLUSTER_ID'),
  tigerBeetleReplicaAddresses: Config.schema(ReplicaAddresses, 'BAYN_TIGERBEETLE_ADDRESSES'),
  tigerBeetleLedger: Config.schema(PositiveInteger, 'BAYN_TIGERBEETLE_LEDGER'),
})

const StrictParseOptions = { onExcessProperty: 'error' } as const
const decodeEmbeddedBuildMetadata = Schema.decodeUnknownSync(EmbeddedBuildMetadataSchema, StrictParseOptions)
const maxU128 = (1n << 128n) - 1n

export const loadRestoreConfig = (
  embedded: EmbeddedBuildMetadata | undefined = embeddedBuildMetadata,
  contract: RestoreContract = restoreContract,
): Effect.Effect<RestoreConfig, OperationalError> =>
  restoreConfig.pipe(
    Effect.mapError((cause) =>
      operationalError('config', 'load-ledger-restore', 'invalid restore configuration', cause),
    ),
    Effect.flatMap((config) =>
      Effect.try({
        try: (): RestoreConfig => {
          if (embedded === undefined) throw new Error('ledger restore requires compile-time build metadata')
          if (!config.postgresTls) throw new Error('ledger restore requires verified PostgreSQL TLS')
          if (config.tigerBeetleClusterId <= 0n || config.tigerBeetleClusterId > maxU128) {
            throw new Error('TigerBeetle cluster ID must be a non-zero u128')
          }
          if (config.tigerBeetleLedger > 0xffff_ffff) throw new Error('TigerBeetle ledger must fit in a u32')
          if (
            config.runId !== contract.runId ||
            config.expectedAccountCount !== contract.expectedAccountCount ||
            config.expectedTransferCount !== contract.expectedTransferCount ||
            config.tigerBeetleClusterId !== contract.target.clusterId ||
            config.tigerBeetleLedger !== contract.target.ledger ||
            config.tigerBeetleReplicaAddresses.length !== contract.target.replicaAddresses.length ||
            config.tigerBeetleReplicaAddresses.some(
              (address, index) => address !== contract.target.replicaAddresses[index],
            )
          ) {
            throw new Error('restore configuration does not match the pinned one-shot contract')
          }
          const build = decodeEmbeddedBuildMetadata(embedded)
          if (config.sourceRevision !== build.sourceRevision) {
            throw new Error('configured source revision does not match the restore executable')
          }
          if (config.imageRepository !== build.imageRepository) {
            throw new Error('configured image repository does not match the restore executable')
          }
          return {
            runId: config.runId,
            expectedAccountCount: config.expectedAccountCount,
            expectedTransferCount: config.expectedTransferCount,
            operationTimeoutMs: config.operationTimeoutMs,
            build: {
              sourceRevision: build.sourceRevision,
              imageRepository: build.imageRepository,
              imageDigest: config.imageDigest,
            },
            postgres: {
              url: config.postgresUrl,
              tls: config.postgresTls,
              caPath: config.postgresCaPath,
            },
            tigerBeetle: {
              clusterId: config.tigerBeetleClusterId,
              replicaAddresses: config.tigerBeetleReplicaAddresses,
              ledger: config.tigerBeetleLedger,
            },
          }
        },
        catch: (cause) =>
          operationalError('config', 'load-ledger-restore', 'invalid ledger restore configuration', cause),
      }),
    ),
  )

const databaseOperation = <A>(
  effect: Effect.Effect<A, { readonly message: string }>,
  operation: string,
): Effect.Effect<A, OperationalError> =>
  effect.pipe(
    Effect.mapError((cause) => operationalError('database', operation, `PostgreSQL ${operation} failed`, cause)),
  )

const withinDeadline = <A, R>(
  effect: Effect.Effect<A, OperationalError, R>,
  timeoutMs: number,
  component: 'database' | 'journal',
  operation: string,
): Effect.Effect<A, OperationalError, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(operationalError(component, operation, `${component} ${operation} timed out after ${timeoutMs}ms`)),
    }),
  )

const storedProvenance = (stored: StoredEvaluationEvidence) =>
  makeRuntimeProvenance({
    sourceRevision: stored.run.sourceRevision,
    image: { repository: stored.run.imageRepository, digest: stored.run.imageDigest },
    strategy: {
      name: stored.protocol.strategyName,
      behaviorHash: stored.protocol.behaviorHash,
      parameterHash: stored.protocol.parameterHash,
      parameterSchemaVersion: stored.protocol.schemaVersion,
    },
  })

export const restoreLedger = (
  config: RestoreConfig,
): Effect.Effect<RestoreReceipt, OperationalError, EvidenceStore | Journal> =>
  Effect.gen(function* () {
    const evidenceStore = yield* EvidenceStore
    const journal = yield* Journal
    const storedOption = yield* withinDeadline(
      databaseOperation(evidenceStore.read(config.runId), 'read-ledger-restore-evidence'),
      config.operationTimeoutMs,
      'database',
      'read-ledger-restore-evidence',
    )
    if (Option.isNone(storedOption)) {
      return yield* Effect.fail(
        operationalError('database', 'read-ledger-restore-evidence', `run ${config.runId} is missing`),
      )
    }
    const stored = storedOption.value
    const provenance = yield* Effect.try({
      try: () => storedProvenance(stored),
      catch: (cause) =>
        operationalError('database', 'validate-ledger-restore', 'stored execution provenance is invalid', cause),
    })
    const [qualificationOption, recoveredOption] = yield* withinDeadline(
      databaseOperation(
        Effect.all([evidenceStore.readQualification(config.runId), evidenceStore.recover(config.runId, provenance)]),
        'recover-ledger-restore-evidence',
      ),
      config.operationTimeoutMs,
      'database',
      'recover-ledger-restore-evidence',
    )
    if (Option.isNone(qualificationOption) || qualificationOption.value.state !== 'TERMINAL') {
      return yield* Effect.fail(
        operationalError('database', 'validate-ledger-restore', `run ${config.runId} has no terminal qualification`),
      )
    }
    if (Option.isNone(recoveredOption)) {
      return yield* Effect.fail(
        operationalError('database', 'validate-ledger-restore', `run ${config.runId} cannot be recovered`),
      )
    }
    const qualification = qualificationOption.value
    const recovered = recoveredOption.value
    const inputArtifacts = stored.artifacts.filter((artifact) => artifact.name === 'input-manifest')
    if (inputArtifacts.length !== 1) {
      return yield* Effect.fail(
        operationalError('database', 'validate-ledger-restore', 'stored run must have exactly one input manifest'),
      )
    }
    const [inputManifest, events] = yield* Effect.all([
      decodeInputManifestArtifact(inputArtifacts[0].payload),
      decodeEvaluationEvents(stored.events.map((event) => event.payload)),
    ]).pipe(
      Effect.mapError((cause) =>
        operationalError('database', 'validate-ledger-restore', 'stored ledger input is invalid', cause),
      ),
    )
    const ledgerInput: LedgerInput = {
      runId: stored.run.runId,
      initialCapitalMicros: stored.run.initialCapitalMicros,
      inputManifest,
      events,
    }
    const plan = yield* Effect.try({
      try: () => buildLedgerPlan(ledgerInput, config.tigerBeetle.ledger),
      catch: (cause) => operationalError('journal', 'plan-ledger-restore', 'ledger restore plan is invalid', cause),
    })
    const planHash = hashLedgerPlan(plan)
    yield* Effect.try({
      try: () => {
        if (
          stored.run.runId !== config.runId ||
          qualification.lock.candidateRunId !== config.runId ||
          qualification.result.runId !== config.runId ||
          recovered.evaluation.runId !== config.runId ||
          recovered.reconciliation.runId !== config.runId
        ) {
          throw new Error('run identities diverged')
        }
        if (
          qualification.lock.protocolHash !== stored.run.protocolHash ||
          qualification.lock.sourceRevision !== stored.run.sourceRevision ||
          canonicalHashV1(qualification.lock.image) !==
            canonicalHashV1({ repository: stored.run.imageRepository, digest: stored.run.imageDigest }) ||
          canonicalHashV1(qualification.result.evaluationVerdict) !== canonicalHashV1(recovered.evaluation.verdict)
        ) {
          throw new Error('qualification binding diverged from stored evidence')
        }
        if (
          recovered.reconciliation.accountCount !== config.expectedAccountCount ||
          recovered.reconciliation.transferCount !== config.expectedTransferCount ||
          plan.accounts.length !== config.expectedAccountCount ||
          plan.transfers.length !== config.expectedTransferCount
        ) {
          throw new Error('precommitted ledger counts diverged from the recovered evidence or restore plan')
        }
        if (
          stored.events.some((event, index) => event.id !== events[index]?.id || event.kind !== events[index]?.kind)
        ) {
          throw new Error('decoded ledger events diverged from their durable references')
        }
      },
      catch: (cause) =>
        operationalError('database', 'validate-ledger-restore', 'ledger restore evidence failed validation', cause),
    })
    const reconciliation = yield* withinDeadline(
      journal.journalAndReconcile(ledgerInput),
      config.operationTimeoutMs,
      'journal',
      'restore-and-reconcile',
    )
    yield* Effect.try({
      try: () => {
        if (canonicalHashV1(reconciliation) !== canonicalHashV1(recovered.reconciliation)) {
          throw new Error('target reconciliation differs from the immutable source receipt')
        }
      },
      catch: (cause) =>
        operationalError('journal', 'restore-and-reconcile', 'target ledger reconciliation failed', cause),
    })
    return {
      schemaVersion: 'bayn.ledger-restore-receipt.v1' as const,
      source: {
        revision: stored.run.sourceRevision,
        image: {
          repository: stored.run.imageRepository,
          digest: stored.run.imageDigest,
        },
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
        ledger: config.tigerBeetle.ledger,
      },
      runId: config.runId,
      qualification: qualification.result.verdict,
      accountCount: reconciliation.accountCount,
      transferCount: reconciliation.transferCount,
      exact: true as const,
      planHash,
    }
  }).pipe(Effect.withLogSpan('restore-ledger'))
