import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Context, Data, Effect, FileSystem, Layer, Schema } from 'effect'
import { SqlSchema } from 'effect/unstable/sql'
import { isSqlError } from 'effect/unstable/sql/SqlError'

import type { RuntimeConfig } from '../config'
import { makeRunIdentity, type RuntimeProvenance } from '../contracts'
import { canonicalHashV1 } from '../hash'
import type { EvaluationResult, ReconciliationResult } from '../types'
import { migrationLoader } from './migrations'

export type DatabaseFailure = 'constraint' | 'decode' | 'invariant' | 'migration' | 'query' | 'unavailable'

export class DatabaseError extends Data.TaggedError('DatabaseError')<{
  readonly failure: DatabaseFailure
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export interface PersistenceReceipt {
  readonly runId: string
  readonly deduplicated: boolean
  readonly artifactCount: number
  readonly eventCount: number
  readonly gateCount: number
}

export interface PersistEvaluationInput {
  readonly provenance: RuntimeProvenance
  readonly parameters: unknown
  readonly evaluation: EvaluationResult
  readonly reconciliation: ReconciliationResult
}

export interface EvidenceStoreService {
  readonly check: Effect.Effect<void, DatabaseError>
  readonly persist: (input: PersistEvaluationInput) => Effect.Effect<PersistenceReceipt, DatabaseError>
}

export class EvidenceStore extends Context.Service<EvidenceStore, EvidenceStoreService>()('bayn/EvidenceStore') {}

interface ArtifactPlan {
  readonly name: string
  readonly schemaVersion: string
  readonly contentHash: string
  readonly payload: unknown
}

interface EventPlan {
  readonly ordinal: number
  readonly id: string
  readonly kind: 'decision' | 'fill'
  readonly contentHash: string
  readonly payload: unknown
}

interface GatePlan {
  readonly ordinal: number
  readonly name: string
  readonly passed: boolean
  readonly actual: number | boolean | string
  readonly required: number | boolean | string
  readonly contentHash: string
}

interface PersistencePlan extends PersistEvaluationInput {
  readonly strategyName: string
  readonly protocolHash: string
  readonly snapshotId: string
  readonly artifacts: readonly ArtifactPlan[]
  readonly events: readonly EventPlan[]
  readonly gates: readonly GatePlan[]
}

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const GitRevision = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const RunRequest = Schema.Struct({ runId: Sha256 })
const InsertedRun = Schema.Struct({ run_id: Sha256 })
const HealthRow = Schema.Struct({ value: Schema.Literal(1) })
const ProtocolRow = Schema.Struct({
  protocol_hash: Sha256,
  schema_version: Schema.String,
  strategy_name: Schema.String,
  behavior_hash: Sha256,
  parameter_hash: Sha256,
  parameters: Schema.Unknown,
})
const SnapshotRow = Schema.Struct({
  snapshot_id: Sha256,
  schema_version: Schema.String,
  database_name: Schema.String,
  table_name: Schema.String,
  dataset_version: Schema.String,
  source: Schema.String,
  source_feed: Schema.String,
  adjustment: Schema.String,
  content_hash: Sha256,
  row_count: PositiveInteger,
  first_session: Schema.String,
  last_session: Schema.String,
  manifest: Schema.Unknown,
})
const ReceiptRow = Schema.Struct({
  run_id: Sha256,
  protocol_hash: Sha256,
  snapshot_id: Sha256,
  evaluation_schema_version: Schema.String,
  source_revision: GitRevision,
  image_repository: Schema.String,
  image_digest: ImageDigest,
  strategy_name: Schema.String,
  initial_capital_micros: Schema.String,
  status: Schema.Literal('COMPLETE'),
  expected_artifact_count: PositiveInteger,
  expected_event_count: NonNegativeInteger,
  expected_gate_count: PositiveInteger,
  artifact_count: NonNegativeInteger,
  event_count: NonNegativeInteger,
  gate_count: NonNegativeInteger,
})
const ArtifactReferenceRow = Schema.Struct({
  artifact_name: Schema.String,
  schema_version: Schema.String,
  content_hash: Sha256,
  payload: Schema.Unknown,
})
const EventReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  event_id: Sha256,
  event_kind: Schema.Literals(['decision', 'fill']),
  content_hash: Sha256,
  payload: Schema.Unknown,
})
const GateReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  gate_name: Schema.String,
  passed: Schema.Boolean,
  actual: Schema.Unknown,
  required: Schema.Unknown,
  content_hash: Sha256,
})
const StatusReferenceRow = Schema.Struct({
  status: Schema.Literals(['WRITING', 'COMPLETE']),
  detail: Schema.Unknown,
})

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const errorCodeOf = (cause: unknown, depth = 0): string | undefined => {
  if (depth > 4 || typeof cause !== 'object' || cause === null) return undefined
  if ('code' in cause && typeof cause.code === 'string') return cause.code
  return 'cause' in cause ? errorCodeOf(cause.cause, depth + 1) : undefined
}

const databaseError = (failure: DatabaseFailure, operation: string, message: string, cause?: unknown): DatabaseError =>
  new DatabaseError({
    failure,
    operation,
    message: cause === undefined ? message : `${message}: ${messageOf(cause)}`,
    cause,
  })

const classifyDatabaseError = (operation: string, cause: unknown): DatabaseError => {
  if (cause instanceof DatabaseError) return cause
  if (Schema.isSchemaError(cause)) return databaseError('decode', operation, 'database row decoding failed', cause)
  if (isSqlError(cause)) {
    const code = errorCodeOf(cause.reason)
    const failure: DatabaseFailure =
      cause.reason._tag === 'UniqueViolation' || cause.reason._tag === 'ConstraintError'
        ? 'constraint'
        : cause.reason._tag === 'SqlSyntaxError' ||
            (cause.reason._tag === 'UnknownError' &&
              code !== undefined &&
              !code.startsWith('E') &&
              !code.startsWith('08'))
          ? 'query'
          : 'unavailable'
    return databaseError(failure, operation, 'PostgreSQL operation failed', cause)
  }
  return databaseError('invariant', operation, 'unexpected database result', cause)
}

const runDatabase = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, DatabaseError, R> =>
  effect.pipe(Effect.mapError((cause) => classifyDatabaseError(operation, cause)))

const ensure = (condition: boolean, operation: string, message: string): Effect.Effect<void, DatabaseError> =>
  condition ? Effect.void : Effect.fail(databaseError('invariant', operation, message))

const makePersistencePlan = (input: PersistEvaluationInput): PersistencePlan => {
  const { evaluation, parameters, provenance, reconciliation } = input
  const strategyName = provenance.strategy.name
  const protocolHash = canonicalHashV1(parameters)
  if (protocolHash !== evaluation.protocolHash || protocolHash !== provenance.strategy.parameterHash) {
    throw new TypeError('evaluation, strategy parameters, and provenance disagree on protocol hash')
  }
  if (evaluation.codeRevision !== provenance.sourceRevision) {
    throw new TypeError('evaluation code revision does not match runtime provenance')
  }
  if (reconciliation.runId !== evaluation.runId || reconciliation.exact !== true) {
    throw new TypeError('reconciliation does not exactly match the evaluation run')
  }
  const { hash: inputManifestHash, ...manifestMaterial } = evaluation.inputManifest
  if (canonicalHashV1(manifestMaterial) !== inputManifestHash) {
    throw new TypeError('input manifest hash does not match its content')
  }
  const snapshotId = evaluation.inputManifest.finalizedSnapshot.snapshotId
  const expectedRunId = makeRunIdentity({
    schemaVersion: 'bayn.run-identity.v1',
    sourceRevision: provenance.sourceRevision,
    image: provenance.image,
    strategy: {
      name: strategyName,
      behaviorHash: provenance.strategy.behaviorHash,
      parameters,
    },
    finalizedSnapshot: evaluation.inputManifest.finalizedSnapshot,
    calendarVersion: evaluation.inputManifest.finalizedSnapshot.calendarVersion,
    bounds: evaluation.inputManifest.bounds,
  }).runId
  if (evaluation.runId !== expectedRunId) throw new TypeError('run ID does not match runtime and input provenance')

  const artifacts = [
    ['input-manifest', evaluation.inputManifest.schemaVersion, evaluation.inputManifest],
    ['strategy', 'bayn.performance-metrics.v1', evaluation.strategy],
    ['buy-and-hold', 'bayn.performance-metrics.v1', evaluation.buyAndHold],
    ['direct-volatility-timing', 'bayn.performance-metrics.v1', evaluation.directVolTiming],
    ['double-cost-strategy', 'bayn.performance-metrics.v1', evaluation.doubleCostStrategy],
    ['reconciliation', 'bayn.reconciliation.v1', reconciliation],
  ].map(([name, schemaVersion, payload]) => ({
    name: name as string,
    schemaVersion: schemaVersion as string,
    contentHash: canonicalHashV1(payload),
    payload,
  }))
  const events = evaluation.events.map((event, ordinal) => ({
    ordinal,
    id: event.id,
    kind: event.kind,
    contentHash: canonicalHashV1(event),
    payload: event,
  }))
  const gates = evaluation.verdict.gates.map((gate, ordinal) => ({
    ordinal,
    name: gate.name,
    passed: gate.passed,
    actual: gate.actual,
    required: gate.required,
    contentHash: canonicalHashV1(gate),
  }))
  if (events.length === 0) throw new TypeError('evaluation produced no durable events')
  if (gates.length === 0) throw new TypeError('evaluation produced no economic gate outcomes')

  return { ...input, strategyName, protocolHash, snapshotId, artifacts, events, gates }
}

const makeEvidenceStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const jsonScalar = (value: number | boolean | string) =>
    sql.json(typeof value === 'string' ? JSON.stringify(value) : value)

  const health = SqlSchema.findOne({
    Request: Schema.Void,
    Result: HealthRow,
    execute: () => sql`SELECT 1::integer AS value`,
  })
  const getProtocol = SqlSchema.findOne({
    Request: Schema.Struct({ protocolHash: Sha256 }),
    Result: ProtocolRow,
    execute: ({ protocolHash }) => sql`SELECT * FROM bayn_protocol_locks WHERE protocol_hash = ${protocolHash}`,
  })
  const getSnapshot = SqlSchema.findOne({
    Request: Schema.Struct({ snapshotId: Sha256 }),
    Result: SnapshotRow,
    execute: ({ snapshotId }) => sql`
      SELECT
        snapshot_id,
        schema_version,
        database_name,
        table_name,
        dataset_version,
        source,
        source_feed,
        adjustment,
        content_hash,
        row_count::integer AS row_count,
        first_session::text,
        last_session::text,
        manifest
      FROM bayn_snapshot_references
      WHERE snapshot_id = ${snapshotId}
    `,
  })
  const insertRun = SqlSchema.findAll({
    Request: Schema.Struct({
      runId: Sha256,
      protocolHash: Sha256,
      snapshotId: Sha256,
      evaluationSchemaVersion: Schema.String,
      sourceRevision: Schema.String,
      imageRepository: Schema.String,
      imageDigest: Schema.String,
      strategyName: Schema.String,
      initialCapitalMicros: Schema.String,
      artifactCount: PositiveInteger,
      eventCount: NonNegativeInteger,
      gateCount: PositiveInteger,
    }),
    Result: InsertedRun,
    execute: (request) => sql`
      INSERT INTO bayn_evaluation_runs (
        run_id,
        protocol_hash,
        snapshot_id,
        evaluation_schema_version,
        source_revision,
        image_repository,
        image_digest,
        strategy_name,
        initial_capital_micros,
        expected_artifact_count,
        expected_event_count,
        expected_gate_count,
        status
      ) VALUES (
        ${request.runId},
        ${request.protocolHash},
        ${request.snapshotId},
        ${request.evaluationSchemaVersion},
        ${request.sourceRevision},
        ${request.imageRepository},
        ${request.imageDigest},
        ${request.strategyName},
        ${request.initialCapitalMicros},
        ${request.artifactCount},
        ${request.eventCount},
        ${request.gateCount},
        'WRITING'
      )
      ON CONFLICT (run_id) DO NOTHING
      RETURNING run_id
    `,
  })
  const completeRun = SqlSchema.findAll({
    Request: RunRequest,
    Result: InsertedRun,
    execute: ({ runId }) => sql`
      UPDATE bayn_evaluation_runs AS run
      SET status = 'COMPLETE', completed_at = transaction_timestamp()
      WHERE run.run_id = ${runId}
        AND run.status = 'WRITING'
        AND run.expected_artifact_count = (
          SELECT count(*)::integer FROM bayn_evaluation_artifacts WHERE run_id = ${runId}
        )
        AND run.expected_event_count = (
          SELECT count(*)::integer FROM bayn_evaluation_events WHERE run_id = ${runId}
        )
        AND run.expected_gate_count = (
          SELECT count(*)::integer FROM bayn_gate_outcomes WHERE run_id = ${runId}
        )
      RETURNING run.run_id
    `,
  })
  const getReceipt = SqlSchema.findOne({
    Request: RunRequest,
    Result: ReceiptRow,
    execute: ({ runId }) => sql`
      SELECT
        run.run_id,
        run.protocol_hash,
        run.snapshot_id,
        run.evaluation_schema_version,
        run.source_revision,
        run.image_repository,
        run.image_digest,
        run.strategy_name,
        run.initial_capital_micros::text AS initial_capital_micros,
        run.status,
        run.expected_artifact_count,
        run.expected_event_count,
        run.expected_gate_count,
        (SELECT count(*)::integer FROM bayn_evaluation_artifacts WHERE run_id = run.run_id) AS artifact_count,
        (SELECT count(*)::integer FROM bayn_evaluation_events WHERE run_id = run.run_id) AS event_count,
        (SELECT count(*)::integer FROM bayn_gate_outcomes WHERE run_id = run.run_id) AS gate_count
      FROM bayn_evaluation_runs AS run
      WHERE run.run_id = ${runId}
    `,
  })
  const getArtifactReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: ArtifactReferenceRow,
    execute: ({ runId }) => sql`
      SELECT artifact_name, schema_version, content_hash, payload
      FROM bayn_evaluation_artifacts
      WHERE run_id = ${runId}
      ORDER BY artifact_name
    `,
  })
  const getEventReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: EventReferenceRow,
    execute: ({ runId }) => sql`
      SELECT ordinal, event_id, event_kind, content_hash, payload
      FROM bayn_evaluation_events
      WHERE run_id = ${runId}
      ORDER BY ordinal
    `,
  })
  const getGateReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: GateReferenceRow,
    execute: ({ runId }) => sql`
      SELECT ordinal, gate_name, passed, actual, required, content_hash
      FROM bayn_gate_outcomes
      WHERE run_id = ${runId}
      ORDER BY ordinal
    `,
  })
  const getStatusReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: StatusReferenceRow,
    execute: ({ runId }) => sql`
      SELECT status, detail FROM bayn_status_history WHERE run_id = ${runId} ORDER BY sequence
    `,
  })

  const readReceipt = (plan: PersistencePlan, deduplicated: boolean) =>
    Effect.gen(function* () {
      const row = yield* getReceipt({ runId: plan.evaluation.runId })
      yield* ensure(row.protocol_hash === plan.protocolHash, 'read-receipt', 'stored protocol reference diverged')
      yield* ensure(row.snapshot_id === plan.snapshotId, 'read-receipt', 'stored snapshot reference diverged')
      yield* ensure(
        row.evaluation_schema_version === plan.evaluation.schemaVersion &&
          row.source_revision === plan.provenance.sourceRevision &&
          row.image_repository === plan.provenance.image.repository &&
          row.image_digest === plan.provenance.image.digest &&
          row.strategy_name === plan.strategyName &&
          row.initial_capital_micros === plan.evaluation.initialCapitalMicros,
        'read-receipt',
        'stored run identity diverged from the evaluated runtime',
      )
      yield* ensure(
        row.expected_artifact_count === plan.artifacts.length && row.artifact_count === plan.artifacts.length,
        'read-receipt',
        'stored artifact count is incomplete',
      )
      yield* ensure(
        row.expected_event_count === plan.events.length && row.event_count === plan.events.length,
        'read-receipt',
        'stored event count is incomplete',
      )
      yield* ensure(
        row.expected_gate_count === plan.gates.length && row.gate_count === plan.gates.length,
        'read-receipt',
        'stored gate count is incomplete',
      )
      const artifacts = yield* getArtifactReferences({ runId: plan.evaluation.runId })
      const events = yield* getEventReferences({ runId: plan.evaluation.runId })
      const gates = yield* getGateReferences({ runId: plan.evaluation.runId })
      const statuses = yield* getStatusReferences({ runId: plan.evaluation.runId })
      const expectedArtifacts = [...plan.artifacts].sort((left, right) => left.name.localeCompare(right.name))
      yield* ensure(
        artifacts.every((artifact, index) => {
          const expected = expectedArtifacts[index]
          return (
            expected !== undefined &&
            artifact.artifact_name === expected.name &&
            artifact.schema_version === expected.schemaVersion &&
            artifact.content_hash === expected.contentHash &&
            canonicalHashV1(artifact.payload) === expected.contentHash
          )
        }),
        'read-receipt',
        'stored artifact content diverged',
      )
      yield* ensure(
        events.every((event, index) => {
          const expected = plan.events[index]
          return (
            expected !== undefined &&
            event.ordinal === expected.ordinal &&
            event.event_id === expected.id &&
            event.event_kind === expected.kind &&
            event.content_hash === expected.contentHash &&
            canonicalHashV1(event.payload) === expected.contentHash
          )
        }),
        'read-receipt',
        'stored event content diverged',
      )
      yield* ensure(
        gates.every((gate, index) => {
          const expected = plan.gates[index]
          return (
            expected !== undefined &&
            gate.ordinal === expected.ordinal &&
            gate.gate_name === expected.name &&
            gate.passed === expected.passed &&
            gate.content_hash === expected.contentHash &&
            canonicalHashV1({
              name: gate.gate_name,
              passed: gate.passed,
              actual: gate.actual,
              required: gate.required,
            }) === expected.contentHash
          )
        }),
        'read-receipt',
        'stored gate content diverged',
      )
      yield* ensure(
        statuses.length === 2 &&
          statuses[0].status === 'WRITING' &&
          canonicalHashV1(statuses[0].detail) ===
            canonicalHashV1({
              artifactCount: plan.artifacts.length,
              eventCount: plan.events.length,
              gateCount: plan.gates.length,
            }) &&
          statuses[1].status === 'COMPLETE' &&
          canonicalHashV1(statuses[1].detail) ===
            canonicalHashV1({ reconciliationExact: true, verdict: plan.evaluation.verdict.status }),
        'read-receipt',
        'stored status history diverged',
      )
      return {
        runId: row.run_id,
        deduplicated,
        artifactCount: row.artifact_count,
        eventCount: row.event_count,
        gateCount: row.gate_count,
      }
    })

  const persist = (input: PersistEvaluationInput) =>
    runDatabase(
      'persist',
      Effect.gen(function* () {
        const plan = yield* Effect.try({
          try: () => makePersistencePlan(input),
          catch: (cause) => databaseError('invariant', 'plan', 'invalid evaluation persistence input', cause),
        })

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
            INSERT INTO bayn_protocol_locks (
              protocol_hash,
              schema_version,
              strategy_name,
              behavior_hash,
              parameter_hash,
              parameters
            ) VALUES (
              ${plan.protocolHash},
              ${plan.provenance.strategy.parameterSchemaVersion},
              ${plan.strategyName},
              ${plan.provenance.strategy.behaviorHash},
              ${plan.provenance.strategy.parameterHash},
              ${sql.json(plan.parameters)}
            )
            ON CONFLICT (protocol_hash) DO NOTHING
          `
            const protocol = yield* getProtocol({ protocolHash: plan.protocolHash })
            yield* ensure(
              protocol.schema_version === plan.provenance.strategy.parameterSchemaVersion &&
                protocol.strategy_name === plan.strategyName &&
                protocol.behavior_hash === plan.provenance.strategy.behaviorHash &&
                protocol.parameter_hash === plan.provenance.strategy.parameterHash &&
                canonicalHashV1(protocol.parameters) === plan.protocolHash,
              'protocol-lock',
              'stored protocol lock diverged from the evaluated protocol',
            )

            const inputManifest = plan.evaluation.inputManifest
            const finalizedSnapshot = inputManifest.finalizedSnapshot
            yield* sql`
            INSERT INTO bayn_snapshot_references (
              snapshot_id,
              schema_version,
              database_name,
              table_name,
              dataset_version,
              source,
              source_feed,
              adjustment,
              content_hash,
              row_count,
              first_session,
              last_session,
              manifest
            ) VALUES (
              ${plan.snapshotId},
              ${finalizedSnapshot.schemaVersion},
              ${inputManifest.database},
              ${inputManifest.tables.bars},
              ${finalizedSnapshot.publicationSchemaVersion},
              ${finalizedSnapshot.source},
              ${finalizedSnapshot.sourceFeed},
              ${finalizedSnapshot.adjustment},
              ${finalizedSnapshot.contentHash},
              ${finalizedSnapshot.rowCount},
              ${finalizedSnapshot.firstSession},
              ${finalizedSnapshot.lastSession},
              ${sql.json(finalizedSnapshot)}
            )
            ON CONFLICT (snapshot_id) DO NOTHING
          `
            const storedSnapshot = yield* getSnapshot({ snapshotId: plan.snapshotId })
            yield* ensure(
              storedSnapshot.schema_version === finalizedSnapshot.schemaVersion &&
                storedSnapshot.database_name === inputManifest.database &&
                storedSnapshot.table_name === inputManifest.tables.bars &&
                storedSnapshot.dataset_version === finalizedSnapshot.publicationSchemaVersion &&
                storedSnapshot.source === finalizedSnapshot.source &&
                storedSnapshot.source_feed === finalizedSnapshot.sourceFeed &&
                storedSnapshot.adjustment === finalizedSnapshot.adjustment &&
                storedSnapshot.content_hash === finalizedSnapshot.contentHash &&
                storedSnapshot.row_count === finalizedSnapshot.rowCount &&
                storedSnapshot.first_session === finalizedSnapshot.firstSession &&
                storedSnapshot.last_session === finalizedSnapshot.lastSession &&
                canonicalHashV1(storedSnapshot.manifest) === canonicalHashV1(finalizedSnapshot),
              'snapshot-reference',
              'stored snapshot reference diverged from the evaluated input manifest',
            )

            const inserted = yield* insertRun({
              runId: plan.evaluation.runId,
              protocolHash: plan.protocolHash,
              snapshotId: plan.snapshotId,
              evaluationSchemaVersion: plan.evaluation.schemaVersion,
              sourceRevision: plan.provenance.sourceRevision,
              imageRepository: plan.provenance.image.repository,
              imageDigest: plan.provenance.image.digest,
              strategyName: plan.strategyName,
              initialCapitalMicros: plan.evaluation.initialCapitalMicros,
              artifactCount: plan.artifacts.length,
              eventCount: plan.events.length,
              gateCount: plan.gates.length,
            })
            if (inserted.length === 0) return yield* readReceipt(plan, true)

            yield* sql`
            INSERT INTO bayn_status_history (run_id, status, detail)
            VALUES (
              ${plan.evaluation.runId},
              'WRITING',
              ${sql.json({
                artifactCount: plan.artifacts.length,
                eventCount: plan.events.length,
                gateCount: plan.gates.length,
              })}
            )
          `
            yield* Effect.forEach(
              plan.artifacts,
              (artifact) => sql`
              INSERT INTO bayn_evaluation_artifacts (
                run_id,
                artifact_name,
                schema_version,
                content_hash,
                payload
              ) VALUES (
                ${plan.evaluation.runId},
                ${artifact.name},
                ${artifact.schemaVersion},
                ${artifact.contentHash},
                ${sql.json(artifact.payload)}
              )
            `,
              { discard: true },
            )
            yield* Effect.forEach(
              plan.events,
              (event) => sql`
              INSERT INTO bayn_evaluation_events (
                run_id,
                ordinal,
                event_id,
                event_kind,
                content_hash,
                payload
              ) VALUES (
                ${plan.evaluation.runId},
                ${event.ordinal},
                ${event.id},
                ${event.kind},
                ${event.contentHash},
                ${sql.json(event.payload)}
              )
            `,
              { discard: true },
            )
            yield* Effect.forEach(
              plan.gates,
              (gate) => sql`
              INSERT INTO bayn_gate_outcomes (
                run_id,
                ordinal,
                gate_name,
                passed,
                actual,
                required,
                content_hash
              ) VALUES (
                ${plan.evaluation.runId},
                ${gate.ordinal},
                ${gate.name},
                ${gate.passed},
                ${jsonScalar(gate.actual)},
                ${jsonScalar(gate.required)},
                ${gate.contentHash}
              )
            `,
              { discard: true },
            )
            const completed = yield* completeRun({ runId: plan.evaluation.runId })
            yield* ensure(
              completed.length === 1,
              'complete-run',
              'run could not be completed with exact evidence counts',
            )
            yield* sql`
            INSERT INTO bayn_status_history (run_id, status, detail)
            VALUES (
              ${plan.evaluation.runId},
              'COMPLETE',
              ${sql.json({ reconciliationExact: true, verdict: plan.evaluation.verdict.status })}
            )
          `
            return yield* readReceipt(plan, false)
          }),
        )
      }),
    )

  return {
    check: runDatabase('health', health(undefined).pipe(Effect.asVoid)),
    persist,
  } satisfies EvidenceStoreService
})

export const PostgresClientLive = (config: RuntimeConfig) => {
  const readCertificate = Effect.gen(function* () {
    if (!config.postgres.tls) return undefined
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.readFileString(config.postgres.caPath)
  })
  return Layer.unwrap(
    readCertificate.pipe(
      Effect.mapError((cause) =>
        databaseError('unavailable', 'tls', 'failed to read PostgreSQL CA certificate', cause),
      ),
      Effect.map((ca) =>
        PgClient.layerFrom(
          PgClient.make({
            url: config.postgres.url,
            ssl: ca === undefined ? undefined : { ca, rejectUnauthorized: true },
            applicationName: 'bayn',
            connectTimeout: config.operationTimeoutMs,
            idleTimeout: '30 seconds',
            maxConnections: 2,
            minConnections: 0,
            transformJson: false,
          }).pipe(Effect.mapError((cause) => classifyDatabaseError('connect', cause))),
        ),
      ),
    ),
  )
}

const migrations = PgMigrator.run({ loader: migrationLoader, table: 'bayn_schema_migrations' }).pipe(
  Effect.mapError((cause) =>
    isSqlError(cause)
      ? classifyDatabaseError('migrate', cause)
      : databaseError('migration', 'migrate', 'PostgreSQL migration failed', cause),
  ),
  Effect.asVoid,
)

const MigrationLive = Layer.effectDiscard(migrations)
const EvidenceStoreLayer = Layer.effect(EvidenceStore, makeEvidenceStore)
const EvidenceStoreDatabaseLayer = Layer.merge(MigrationLive, EvidenceStoreLayer)

export const EvidenceStoreLive = (config: RuntimeConfig) =>
  EvidenceStoreDatabaseLayer.pipe(Layer.provideMerge(PostgresClientLive(config)))

export const EvidenceStoreRuntimeLive = (config: RuntimeConfig) =>
  EvidenceStoreDatabaseLayer.pipe(
    Layer.provide(PostgresClientLive(config)),
    Layer.catch((error) =>
      Layer.succeed(EvidenceStore, {
        check: Effect.fail(error),
        persist: () => Effect.fail(error),
      }),
    ),
  )
