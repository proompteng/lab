import { PgClient } from '@effect/sql-pg'
import { Effect, Option, Result, Schema } from 'effect'
import { SqlSchema } from 'effect/unstable/sql'

import { FinalizedSnapshotProvenanceSchema, type RuntimeProvenance } from '../../contracts'
import { EvaluationEventSchema } from '../../evidence-contracts'
import { QualificationLockSchema, QualificationResultSchema } from '../../qualification'
import { ProtocolSchema } from '../../protocol'
import type { InputManifest, Protocol } from '../../types'
import {
  completeEvidenceRecovery,
  prepareEvidenceRecovery,
  renderEvidenceRecoveryIssue,
  validateStoredEvidence,
  type EvidenceRecoveryIssue,
  type RecoveredEvaluationEvidence,
  type StoredEvidenceRows,
  type StoredEvaluationEvidence,
} from '../evidence-recovery'
import {
  ensureSnapshotReferenceResult as ensureSnapshotReferenceRow,
  renderSnapshotReferenceIssue,
} from '../snapshot-reference'
import { databaseError, ensure, runDatabase, type DatabaseError } from './errors'
import type { ArtifactItemPage, EvidenceStoreService, PersistEvaluationInput, QualificationRecord } from './model'
import {
  makePersistencePlan,
  renderPersistencePlanFailure,
  validatePersistenceReceipt,
  validateProtocolReference,
  type PersistencePlan,
  type PersistencePlanFailure,
} from './persistence'
import {
  decodeQualificationRecord,
  renderQualificationDecisionFailure,
  validateQualificationLineage,
  validateQualificationLockMatch,
  validateQualificationOpenInput,
  type QualificationDecisionFailure,
} from './qualification'

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const GitRevision = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))
const ImageDigest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const GateScalar = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String])
const RunRequest = Schema.Struct({ runId: Sha256 })
const InsertedRun = Schema.Struct({ run_id: Sha256 })
const HealthRow = Schema.Struct({ value: Schema.Literal(1) })
const ProtocolRow = Schema.Struct({
  protocol_hash: Sha256,
  schema_version: Schema.String,
  strategy_name: Schema.String,
  behavior_hash: Sha256,
  parameter_hash: Sha256,
  parameters: ProtocolSchema,
})
const SnapshotRow = Schema.Struct({
  snapshot_id: Sha256,
  schema_version: Schema.Literal('bayn.finalized-snapshot.v3'),
  database_name: Schema.Literal('signal'),
  table_name: Schema.Literal('adjusted_daily_bars_v2'),
  dataset_version: Schema.Literal('signal.adjusted-daily-snapshot.v2'),
  source: Schema.Literal('alpaca'),
  source_feed: Schema.Literal('sip'),
  adjustment: Schema.Literal('all'),
  content_hash: Sha256,
  row_count: PositiveInteger,
  first_session: Schema.String,
  last_session: Schema.String,
  manifest: FinalizedSnapshotProvenanceSchema,
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
  payload: Schema.Json,
})
const ArtifactSeriesMetadataRow = Schema.Struct({
  schema_version: Schema.String,
  content_hash: Sha256,
  item_count: NonNegativeInteger,
})
const ArtifactItemRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  payload: Schema.Json,
})
const EventReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  event_id: Sha256,
  event_kind: Schema.Literals(['decision', 'fill', 'fee', 'cash-yield']),
  content_hash: Sha256,
  payload: EvaluationEventSchema,
})
const GateReferenceRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  gate_name: Schema.String,
  passed: Schema.Boolean,
  actual: GateScalar,
  required: GateScalar,
  content_hash: Sha256,
})
const StatusReferenceRow = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('WRITING'),
    detail: Schema.Struct({
      artifactCount: PositiveInteger,
      eventCount: NonNegativeInteger,
      gateCount: PositiveInteger,
    }),
  }),
  Schema.Struct({
    status: Schema.Literal('COMPLETE'),
    detail: Schema.Struct({
      reconciliationExact: Schema.Literal(true),
      verdict: Schema.Literals(['PASS', 'FAIL_CLOSED']),
    }),
  }),
])
const QualificationTrialRow = Schema.Struct({ run_id: Sha256 })
const QualificationRow = Schema.Struct({
  lock_payload: QualificationLockSchema,
  result_payload: Schema.NullOr(QualificationResultSchema),
})
const CandidateRunCountRow = Schema.Struct({ count: NonNegativeInteger })
const InsertedLockRow = Schema.Struct({ lock_id: Sha256 })
const InsertedResultRow = Schema.Struct({ lock_id: Sha256 })
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const persistencePlanDatabaseError = (operation: string, failure: Parameters<typeof renderPersistencePlanFailure>[0]) =>
  databaseError(
    'invariant',
    operation,
    renderPersistencePlanFailure(failure),
    failure._tag === 'SimulationReconciliationFailed' ? failure.issues : failure,
  )

const liftPersistenceResult = <A>(
  operation: string,
  result: Result.Result<A, PersistencePlanFailure>,
): Effect.Effect<A, DatabaseError> =>
  Effect.fromResult(result).pipe(Effect.mapError((failure) => persistencePlanDatabaseError(operation, failure)))

const liftQualificationResult = <A>(
  operation: string,
  result: Result.Result<A, QualificationDecisionFailure>,
): Effect.Effect<A, DatabaseError> =>
  Effect.fromResult(result).pipe(
    Effect.mapError((cause) => databaseError('invariant', operation, renderQualificationDecisionFailure(cause), cause)),
  )

const recoveryIssueDatabaseError = (operation: string, issue: EvidenceRecoveryIssue): DatabaseError => {
  return databaseError(
    issue._tag === 'DecodeFailure' ? 'decode' : 'invariant',
    operation,
    renderEvidenceRecoveryIssue(issue),
    issue._tag === 'SimulationFailure' ? issue.issues : issue,
  )
}

const liftRecoveryResult = <A>(
  operation: string,
  result: Result.Result<A, EvidenceRecoveryIssue>,
): Effect.Effect<A, DatabaseError> =>
  Effect.fromResult(result).pipe(Effect.mapError((issue) => recoveryIssueDatabaseError(operation, issue)))

export const makeEvidenceStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const jsonScalar = (value: number | boolean | string) => sql.json(encodeJson(value))

  const health = SqlSchema.findOne({
    Request: Schema.Void,
    Result: HealthRow,
    execute: () => sql`SELECT 1::integer AS value`,
  })
  const getProtocol = SqlSchema.findOne({
    Request: Schema.Struct({ protocolHash: Sha256 }),
    Result: ProtocolRow,
    execute: ({ protocolHash }) => sql`SELECT * FROM protocol_locks WHERE protocol_hash = ${protocolHash}`,
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
      FROM snapshot_references
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
      INSERT INTO evaluation_runs (
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
      UPDATE evaluation_runs AS run
      SET status = 'COMPLETE', completed_at = transaction_timestamp()
      WHERE run.run_id = ${runId}
        AND run.status = 'WRITING'
        AND run.expected_artifact_count = (
          SELECT count(*)::integer FROM evaluation_artifacts WHERE run_id = ${runId}
        )
        AND run.expected_event_count = (
          SELECT count(*)::integer FROM evaluation_events WHERE run_id = ${runId}
        )
        AND run.expected_gate_count = (
          SELECT count(*)::integer FROM gate_outcomes WHERE run_id = ${runId}
        )
      RETURNING run.run_id
    `,
  })
  const getReceipt = SqlSchema.findAll({
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
        (SELECT count(*)::integer FROM evaluation_artifacts WHERE run_id = run.run_id) AS artifact_count,
        (SELECT count(*)::integer FROM evaluation_events WHERE run_id = run.run_id) AS event_count,
        (SELECT count(*)::integer FROM gate_outcomes WHERE run_id = run.run_id) AS gate_count
      FROM evaluation_runs AS run
      WHERE run.run_id = ${runId}
    `,
  })
  const getArtifactReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: ArtifactReferenceRow,
    execute: ({ runId }) => sql`
      SELECT artifact_name, schema_version, content_hash, payload
      FROM evaluation_artifacts
      WHERE run_id = ${runId}
      ORDER BY artifact_name
    `,
  })
  const getArtifactSeriesMetadata = SqlSchema.findAll({
    Request: Schema.Struct({ runId: Sha256, artifactName: Schema.String }),
    Result: ArtifactSeriesMetadataRow,
    execute: ({ runId, artifactName }) => sql`
      SELECT
        artifact.schema_version,
        artifact.content_hash,
        jsonb_array_length(artifact.payload -> 'items')::integer AS item_count
      FROM evaluation_artifacts AS artifact
      JOIN evaluation_runs AS run USING (run_id)
      WHERE artifact.run_id = ${runId}
        AND artifact.artifact_name = ${artifactName}
        AND run.status = 'COMPLETE'
        AND jsonb_typeof(artifact.payload -> 'items') = 'array'
    `,
  })
  const getArtifactItems = SqlSchema.findAll({
    Request: Schema.Struct({
      runId: Sha256,
      artifactName: Schema.String,
      afterOrdinal: Schema.Int,
      limit: PositiveInteger,
    }),
    Result: ArtifactItemRow,
    execute: ({ runId, artifactName, afterOrdinal, limit }) => sql`
      SELECT (item.ordinality - 1)::integer AS ordinal, item.payload
      FROM evaluation_artifacts AS artifact
      CROSS JOIN LATERAL jsonb_array_elements(artifact.payload -> 'items')
        WITH ORDINALITY AS item(payload, ordinality)
      WHERE artifact.run_id = ${runId}
        AND artifact.artifact_name = ${artifactName}
        AND (item.ordinality - 1) > ${afterOrdinal}
      ORDER BY item.ordinality
      LIMIT ${limit}
    `,
  })
  const getEventReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: EventReferenceRow,
    execute: ({ runId }) => sql`
      SELECT ordinal, event_id, event_kind, content_hash, payload
      FROM evaluation_events
      WHERE run_id = ${runId}
      ORDER BY ordinal
    `,
  })
  const getGateReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: GateReferenceRow,
    execute: ({ runId }) => sql`
      SELECT ordinal, gate_name, passed, actual, required, content_hash
      FROM gate_outcomes
      WHERE run_id = ${runId}
      ORDER BY ordinal
    `,
  })
  const getStatusReferences = SqlSchema.findAll({
    Request: RunRequest,
    Result: StatusReferenceRow,
    execute: ({ runId }) => sql`
      SELECT status, detail FROM status_history WHERE run_id = ${runId} ORDER BY sequence
    `,
  })
  const getPriorTrials = SqlSchema.findAll({
    Request: Schema.Void,
    Result: QualificationTrialRow,
    execute: () => sql`
      SELECT run_id
      FROM (
        SELECT run_id FROM qualification_trials
        UNION
        SELECT run_id FROM qualification_results
      ) AS trials
      ORDER BY run_id
    `,
  })
  const getQualificationByCandidate = SqlSchema.findAll({
    Request: Schema.Struct({ candidateRunId: Sha256 }),
    Result: QualificationRow,
    execute: ({ candidateRunId }) => sql`
      SELECT lock.payload AS lock_payload, result.payload AS result_payload
      FROM qualification_locks AS lock
      LEFT JOIN qualification_results AS result USING (lock_id)
      WHERE lock.candidate_run_id = ${candidateRunId}
    `,
  })
  const getQualificationByIdentity = SqlSchema.findAll({
    Request: Schema.Struct({ candidateRunId: Sha256, snapshotId: Sha256 }),
    Result: QualificationRow,
    execute: ({ candidateRunId, snapshotId }) => sql`
      SELECT lock.payload AS lock_payload, result.payload AS result_payload
      FROM qualification_locks AS lock
      LEFT JOIN qualification_results AS result USING (lock_id)
      WHERE lock.candidate_run_id = ${candidateRunId} OR lock.snapshot_id = ${snapshotId}
      ORDER BY lock.lock_id
    `,
  })
  const insertQualificationLock = SqlSchema.findAll({
    Request: Schema.Struct({
      lockId: Sha256,
      schemaVersion: Schema.Literal('bayn.qualification-lock.v3'),
      candidateRunId: Sha256,
      protocolHash: Sha256,
      snapshotId: Sha256,
      sourceRevision: GitRevision,
      imageRepository: Schema.String,
      imageDigest: ImageDigest,
      payload: QualificationLockSchema,
    }),
    Result: InsertedLockRow,
    execute: (request) => sql`
      INSERT INTO qualification_locks (
        lock_id,
        schema_version,
        candidate_run_id,
        protocol_hash,
        snapshot_id,
        source_revision,
        image_repository,
        image_digest,
        payload
      ) VALUES (
        ${request.lockId},
        ${request.schemaVersion},
        ${request.candidateRunId},
        ${request.protocolHash},
        ${request.snapshotId},
        ${request.sourceRevision},
        ${request.imageRepository},
        ${request.imageDigest},
        ${sql.json(request.payload)}
      )
      ON CONFLICT DO NOTHING
      RETURNING lock_id
    `,
  })
  const insertQualificationResult = SqlSchema.findAll({
    Request: Schema.Struct({
      lockId: Sha256,
      schemaVersion: Schema.Literal('bayn.qualification-result.v2'),
      runId: Sha256,
      verdict: Schema.Literals(['QUALIFIED', 'REJECTED']),
      analysisHash: Sha256,
      resultHash: Sha256,
      payload: QualificationResultSchema,
    }),
    Result: InsertedResultRow,
    execute: (request) => sql`
      INSERT INTO qualification_results (
        lock_id,
        schema_version,
        run_id,
        verdict,
        analysis_hash,
        result_hash,
        payload
      ) VALUES (
        ${request.lockId},
        ${request.schemaVersion},
        ${request.runId},
        ${request.verdict},
        ${request.analysisHash},
        ${request.resultHash},
        ${sql.json(request.payload)}
      )
      ON CONFLICT DO NOTHING
      RETURNING lock_id
    `,
  })
  const getCandidateRunCount = SqlSchema.findOne({
    Request: Schema.Struct({ candidateRunId: Sha256 }),
    Result: CandidateRunCountRow,
    execute: ({ candidateRunId }) => sql`
      SELECT count(*)::integer AS count FROM evaluation_runs WHERE run_id = ${candidateRunId}
    `,
  })
  const getIncompleteQualificationCount = SqlSchema.findOne({
    Request: Schema.Void,
    Result: CandidateRunCountRow,
    execute: () => sql`
      SELECT count(*)::integer AS count
      FROM qualification_locks AS lock
      LEFT JOIN qualification_results AS result USING (lock_id)
      WHERE result.lock_id IS NULL
    `,
  })

  const decodeSingleQualification = (
    rows: readonly (typeof QualificationRow.Type)[],
    operation: string,
  ): Effect.Effect<Option.Option<QualificationRecord>, DatabaseError> =>
    Effect.gen(function* () {
      if (rows.length === 0) return Option.none<QualificationRecord>()
      yield* ensure(rows.length === 1, operation, 'qualification identity is duplicated or divergent')
      const row = rows[0]
      if (row === undefined) {
        return yield* Effect.fail(databaseError('invariant', operation, 'qualification row disappeared'))
      }
      const record = yield* Effect.fromResult(decodeQualificationRecord(row)).pipe(
        Effect.mapError((cause) =>
          databaseError('invariant', operation, renderQualificationDecisionFailure(cause), cause),
        ),
      )
      return Option.some(record)
    })

  const ensureProtocolReference = (input: {
    readonly protocolHash: string
    readonly provenance: RuntimeProvenance
    readonly parameters: Protocol
  }) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO protocol_locks (
          protocol_hash,
          schema_version,
          strategy_name,
          behavior_hash,
          parameter_hash,
          parameters
        ) VALUES (
          ${input.protocolHash},
          ${input.provenance.strategy.parameterSchemaVersion},
          ${input.provenance.strategy.name},
          ${input.provenance.strategy.behaviorHash},
          ${input.provenance.strategy.parameterHash},
          ${sql.json(input.parameters)}
        )
        ON CONFLICT (protocol_hash) DO NOTHING
      `
      const protocol = yield* getProtocol({ protocolHash: input.protocolHash })
      yield* liftPersistenceResult('protocol-lock', validateProtocolReference(input, protocol))
    })

  const ensureSnapshotReference = (inputManifest: InputManifest) =>
    Effect.gen(function* () {
      const validated = yield* ensureSnapshotReferenceRow(sql, inputManifest)
      yield* Effect.fromResult(validated).pipe(
        Effect.mapError((cause) =>
          databaseError('invariant', 'snapshot-reference', renderSnapshotReferenceIssue(cause), cause),
        ),
      )
    })

  const readReceipt = (plan: PersistencePlan, deduplicated: boolean) =>
    Effect.gen(function* () {
      const rows = yield* getReceipt({ runId: plan.evaluation.runId })
      const artifacts = yield* getArtifactReferences({ runId: plan.evaluation.runId })
      const events = yield* getEventReferences({ runId: plan.evaluation.runId })
      const gates = yield* getGateReferences({ runId: plan.evaluation.runId })
      const statuses = yield* getStatusReferences({ runId: plan.evaluation.runId })
      return yield* liftPersistenceResult(
        'read-receipt',
        validatePersistenceReceipt(plan, { receipts: rows, artifacts, events, gates, statuses }, deduplicated),
      )
    })

  const loadStoredRows = (runId: string) =>
    Effect.gen(function* () {
      const receipts = yield* getReceipt({ runId })
      if (receipts.length === 0) return Option.none<StoredEvidenceRows>()
      const receipt = receipts[0]
      if (receipt === undefined) return Option.none<StoredEvidenceRows>()
      const protocol = yield* getProtocol({ protocolHash: receipt.protocol_hash })
      const artifacts = yield* getArtifactReferences({ runId })
      const events = yield* getEventReferences({ runId })
      const gates = yield* getGateReferences({ runId })
      const statuses = yield* getStatusReferences({ runId })
      return Option.some({ receipts, protocol, artifacts, events, gates, statuses } satisfies StoredEvidenceRows)
    })

  const readStored = (operation: string, runId: string) =>
    Effect.gen(function* () {
      const rows = yield* loadStoredRows(runId)
      if (Option.isNone(rows)) return Option.none<StoredEvaluationEvidence>()
      const stored = yield* liftRecoveryResult(operation, validateStoredEvidence(runId, rows.value))
      return Option.some(stored)
    })

  const read = (runId: string) => runDatabase('read-evidence', readStored('read-evidence', runId))

  const listPriorTrials = runDatabase(
    'list-prior-trials',
    getPriorTrials(undefined).pipe(Effect.map((rows) => rows.map((row) => row.run_id))),
  )

  const readQualification: EvidenceStoreService['readQualification'] = (candidateRunId) =>
    runDatabase(
      'read-qualification',
      Effect.gen(function* () {
        const rows = yield* getQualificationByCandidate({ candidateRunId })
        return yield* decodeSingleQualification(rows, 'read-qualification')
      }),
    )

  const openQualification: EvidenceStoreService['openQualification'] = (input) =>
    runDatabase(
      'open-qualification',
      Effect.gen(function* () {
        const plan = yield* Effect.fromResult(validateQualificationOpenInput(input)).pipe(
          Effect.mapError((cause) =>
            databaseError('invariant', 'open-qualification', renderQualificationDecisionFailure(cause), cause),
          ),
        )
        const lock = plan.lock
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* ensureProtocolReference({
              protocolHash: lock.protocolHash,
              provenance: plan.provenance,
              parameters: plan.parameters,
            })
            yield* ensureSnapshotReference(plan.inputManifest)
            yield* sql`LOCK TABLE qualification_trials IN SHARE MODE`
            yield* sql`LOCK TABLE qualification_locks IN SHARE ROW EXCLUSIVE MODE`

            const existingRows = yield* getQualificationByIdentity({
              candidateRunId: lock.candidateRunId,
              snapshotId: lock.data.snapshotId,
            })
            const existing = yield* decodeSingleQualification(existingRows, 'open-qualification')
            if (Option.isSome(existing)) {
              yield* liftQualificationResult(
                'open-qualification',
                validateQualificationLockMatch(existing.value.lock, lock),
              )
              return existing.value
            }

            const incompleteCount = yield* getIncompleteQualificationCount(undefined)
            yield* ensure(
              incompleteCount.count === 0,
              'open-qualification',
              'another qualification lock is opened without a terminal result',
            )

            const priorTrialRunIds = (yield* getPriorTrials(undefined)).map((row) => row.run_id)
            yield* liftQualificationResult(
              'open-qualification',
              validateQualificationLineage(priorTrialRunIds, lock.priorTrialRunIds),
            )
            const candidateRunCount = yield* getCandidateRunCount({ candidateRunId: lock.candidateRunId })
            yield* ensure(
              candidateRunCount.count === 0,
              'open-qualification',
              'candidate evaluation was observed before qualification lock acquisition',
            )

            const inserted = yield* insertQualificationLock({
              lockId: lock.lockId,
              schemaVersion: lock.schemaVersion,
              candidateRunId: lock.candidateRunId,
              protocolHash: lock.protocolHash,
              snapshotId: lock.data.snapshotId,
              sourceRevision: lock.sourceRevision,
              imageRepository: lock.image.repository,
              imageDigest: lock.image.digest,
              payload: lock,
            })
            if (inserted.length === 1) return { state: 'ACQUIRED', lock } as const
            yield* ensure(inserted.length === 0, 'open-qualification', 'qualification lock insert was duplicated')

            const rows = yield* getQualificationByIdentity({
              candidateRunId: lock.candidateRunId,
              snapshotId: lock.data.snapshotId,
            })
            const stored = yield* decodeSingleQualification(rows, 'open-qualification')
            if (Option.isNone(stored)) {
              return yield* Effect.fail(
                databaseError('invariant', 'open-qualification', 'conflicting qualification lock is missing'),
              )
            }
            yield* liftQualificationResult(
              'open-qualification',
              validateQualificationLockMatch(stored.value.lock, lock),
            )
            return stored.value
          }),
        )
      }),
    )

  const readArtifactItems: EvidenceStoreService['readArtifactItems'] = ({
    runId,
    artifactName,
    afterOrdinal = -1,
    limit,
  }) =>
    runDatabase(
      'read-artifact-items',
      Effect.gen(function* () {
        yield* ensure(/^[0-9a-f]{64}$/.test(runId), 'read-artifact-items', 'run ID is invalid')
        yield* ensure(
          artifactName.length > 0 && artifactName.trim() === artifactName,
          'read-artifact-items',
          'artifact name is invalid',
        )
        yield* ensure(
          Number.isInteger(afterOrdinal) && afterOrdinal >= -1,
          'read-artifact-items',
          'after ordinal must be an integer greater than or equal to -1',
        )
        yield* ensure(
          Number.isInteger(limit) && limit > 0 && limit <= 256,
          'read-artifact-items',
          'page limit must be between 1 and 256',
        )
        const metadata = yield* getArtifactSeriesMetadata({ runId, artifactName })
        if (metadata.length === 0) return Option.none<ArtifactItemPage>()
        yield* ensure(metadata.length === 1, 'read-artifact-items', 'artifact series metadata is duplicated')
        const rows = yield* getArtifactItems({ runId, artifactName, afterOrdinal, limit })
        yield* ensure(
          rows.every((row, index) => row.ordinal === afterOrdinal + index + 1),
          'read-artifact-items',
          'artifact page is not contiguous',
        )
        const last = rows.at(-1)?.ordinal
        return Option.some({
          runId,
          artifactName,
          schemaVersion: metadata[0].schema_version,
          contentHash: metadata[0].content_hash,
          itemCount: metadata[0].item_count,
          items: rows,
          nextAfterOrdinal: last !== undefined && last < metadata[0].item_count - 1 ? last : null,
        } satisfies ArtifactItemPage)
      }),
    )

  const recover = (runId: string, provenance: RuntimeProvenance) =>
    runDatabase(
      'recover-evidence',
      Effect.gen(function* () {
        const rows = yield* loadStoredRows(runId)
        if (Option.isNone(rows)) return Option.none<RecoveredEvaluationEvidence>()
        const prepared = yield* liftRecoveryResult(
          'recover-evidence',
          prepareEvidenceRecovery({ runId, provenance, rows: rows.value }),
        )
        const snapshot = yield* getSnapshot({ snapshotId: prepared.stored.run.snapshotId })
        const recovered = yield* liftRecoveryResult('recover-evidence', completeEvidenceRecovery(prepared, snapshot))
        return Option.some(recovered)
      }),
    )

  const persist = (input: PersistEvaluationInput) =>
    runDatabase(
      'persist',
      Effect.gen(function* () {
        const plan = yield* Effect.fromResult(makePersistencePlan(input)).pipe(
          Effect.mapError((failure) => persistencePlanDatabaseError('plan', failure)),
        )

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const qualificationRows = yield* getQualificationByCandidate({
              candidateRunId: plan.evaluation.runId,
            })
            const storedQualification = yield* decodeSingleQualification(qualificationRows, 'persist-qualification')
            if (plan.qualification !== undefined) {
              if (Option.isNone(storedQualification)) {
                return yield* Effect.fail(
                  databaseError('invariant', 'persist-qualification', 'qualification lock was not opened'),
                )
              }
              yield* ensure(
                storedQualification.value.state === 'OPENED_INCOMPLETE',
                'persist-qualification',
                'qualification lock is already terminal',
              )
              yield* liftQualificationResult(
                'persist-qualification',
                validateQualificationLockMatch(storedQualification.value.lock, plan.qualification.lock),
              )
            } else {
              yield* ensure(
                Option.isNone(storedQualification),
                'persist-qualification',
                'locked qualification candidate requires its terminal result in the same transaction',
              )
            }
            yield* ensureProtocolReference({
              protocolHash: plan.protocolHash,
              provenance: plan.provenance,
              parameters: plan.parameters,
            })
            yield* ensureSnapshotReference(plan.evaluation.inputManifest)

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
            if (inserted.length === 0) {
              if (plan.qualification !== undefined) {
                return yield* Effect.fail(
                  databaseError(
                    'invariant',
                    'persist-qualification',
                    'locked qualification candidate was already evaluated without a terminal result',
                  ),
                )
              }
              return yield* readReceipt(plan, true)
            }

            yield* sql`
            INSERT INTO status_history (run_id, status, detail)
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
              INSERT INTO evaluation_artifacts (
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
              INSERT INTO evaluation_events (
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
              INSERT INTO gate_outcomes (
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
            INSERT INTO status_history (run_id, status, detail)
            VALUES (
              ${plan.evaluation.runId},
              'COMPLETE',
              ${sql.json({ reconciliationExact: true, verdict: plan.evaluation.verdict.status })}
            )
          `
            if (plan.qualification !== undefined) {
              const result = plan.qualification.result
              const resultRows = yield* insertQualificationResult({
                lockId: result.lockId,
                schemaVersion: result.schemaVersion,
                runId: result.runId,
                verdict: result.verdict,
                analysisHash: result.analysis.analysisHash,
                resultHash: result.resultHash,
                payload: result,
              })
              yield* ensure(
                resultRows.length === 1 && resultRows[0].lock_id === result.lockId,
                'persist-qualification',
                'terminal qualification result was not inserted exactly once',
              )
            }
            return yield* readReceipt(plan, false)
          }),
        )
      }),
    )

  return {
    check: runDatabase('health', health(undefined).pipe(Effect.asVoid)),
    persist,
    read,
    readArtifactItems,
    recover,
    listPriorTrials,
    openQualification,
    readQualification,
  } satisfies EvidenceStoreService
})
