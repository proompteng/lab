import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, Schema } from 'effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'

import { EvaluationEventSchema } from '../../evidence-contracts'
import { ProtocolSchema } from '../../protocol'
import { QualificationLockSchema, QualificationResultSchema } from '../../qualification'
import type { AuditDatabaseSnapshot } from '../../audit/audit'
import {
  NonNegativeIntegerSchema as NonNegativeInteger,
  PositiveIntegerSchema as PositiveInteger,
  Sha256Schema as Sha256,
  TrimmedNonEmptyStringSchema as NonEmptyString,
  strictParseOptions,
} from '../../schemas'
import {
  qualificationAuditCommandError,
  type AcquireAuditDatabaseClient,
  type AuditConfig,
  type AuditDatabaseClient,
  type QualificationAuditCommandError,
} from './model'

const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/))
const GateScalar = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String])

const RunRow = Schema.Struct({
  run_id: Sha256,
  protocol_hash: Sha256,
  snapshot_id: Sha256,
  evaluation_schema_version: NonEmptyString,
  source_revision: NonEmptyString,
  image_repository: NonEmptyString,
  image_digest: NonEmptyString,
  strategy_name: Schema.Literal('risk-balanced-trend'),
  initial_capital_micros: Schema.String,
  status: Schema.Literal('COMPLETE'),
  artifact_count: PositiveInteger,
  event_count: NonNegativeInteger,
  gate_count: PositiveInteger,
  schema_version: NonEmptyString,
  behavior_hash: Sha256,
  parameter_hash: Sha256,
  parameters: ProtocolSchema,
})
const ArtifactRow = Schema.Struct({
  artifact_name: NonEmptyString,
  schema_version: NonEmptyString,
  content_hash: Sha256,
  payload: Schema.Json,
})
const EventRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  event_id: Sha256,
  event_kind: Schema.Literals(['decision', 'fill', 'fee', 'cash-yield']),
  content_hash: Sha256,
  payload: EvaluationEventSchema,
})
const GateRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  gate_name: NonEmptyString,
  passed: Schema.Boolean,
  actual: GateScalar,
  required: GateScalar,
  content_hash: Sha256,
})
const StatusRow = Schema.Union([
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
const TrialRow = Schema.Struct({ run_id: Sha256 })
const QualificationRow = Schema.Struct({
  lock_created_at: IsoInstant,
  result_committed_at: IsoInstant,
  lock_id: Sha256,
  analysis_hash: Sha256,
  result_hash: Sha256,
  verdict: Schema.Literals(['QUALIFIED', 'REJECTED']),
  lock_payload: QualificationLockSchema,
  result_payload: QualificationResultSchema,
})
const ReadOnlyRow = Schema.Struct({ read_only: Schema.Boolean })

const decodeRunRow = Schema.decodeUnknownEffect(Schema.Tuple([RunRow]), strictParseOptions)
const decodeArtifactRows = Schema.decodeUnknownEffect(Schema.Array(ArtifactRow), strictParseOptions)
const decodeEventRows = Schema.decodeUnknownEffect(Schema.Array(EventRow), strictParseOptions)
const decodeGateRows = Schema.decodeUnknownEffect(Schema.Array(GateRow), strictParseOptions)
const decodeStatusRows = Schema.decodeUnknownEffect(Schema.Array(StatusRow), strictParseOptions)
const decodeTrialRows = Schema.decodeUnknownEffect(Schema.Array(TrialRow), strictParseOptions)
const decodeQualificationRow = Schema.decodeUnknownEffect(Schema.Tuple([QualificationRow]), strictParseOptions)
const decodeReadOnlyRow = Schema.decodeUnknownEffect(Schema.Tuple([ReadOnlyRow]), strictParseOptions)

const readPostgresCertificate = (
  input: AuditConfig,
): Effect.Effect<string | undefined, QualificationAuditCommandError, FileSystem.FileSystem> => {
  if (!input.postgresTls) return Effect.succeed(undefined)
  if (input.postgresCaPath.length === 0) {
    return Effect.fail(
      qualificationAuditCommandError('configuration', 'BAYN_AUDIT_POSTGRES_CA_PATH is required with TLS'),
    )
  }
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => fileSystem.readFileString(input.postgresCaPath)),
    Effect.mapError((cause) =>
      qualificationAuditCommandError(
        'configuration',
        'failed to read the qualification-audit PostgreSQL CA certificate',
        cause,
      ),
    ),
  )
}

const readDatabaseWithClient = Effect.fnUntraced(function* (sql: PgClient.PgClient, runId: string) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
      const [readOnly] = yield* decodeReadOnlyRow(
        yield* sql`SELECT current_setting('transaction_read_only') = 'on' AS read_only`,
      )
      const [run] = yield* decodeRunRow(
        yield* sql`
        SELECT run.run_id, run.protocol_hash, run.snapshot_id, run.evaluation_schema_version,
          run.source_revision, run.image_repository, run.image_digest, run.strategy_name,
          run.initial_capital_micros::text AS initial_capital_micros, run.status,
          (SELECT count(*)::integer FROM evaluation_artifacts WHERE run_id = run.run_id) AS artifact_count,
          (SELECT count(*)::integer FROM evaluation_events WHERE run_id = run.run_id) AS event_count,
          (SELECT count(*)::integer FROM gate_outcomes WHERE run_id = run.run_id) AS gate_count,
          protocol.schema_version, protocol.behavior_hash, protocol.parameter_hash, protocol.parameters
        FROM evaluation_runs AS run
        JOIN protocol_locks AS protocol USING (protocol_hash)
        WHERE run.run_id = ${runId}
      `,
      )
      const artifacts = yield* decodeArtifactRows(
        yield* sql`
        SELECT artifact_name, schema_version, content_hash, payload
        FROM evaluation_artifacts WHERE run_id = ${runId} ORDER BY artifact_name
      `,
      )
      const events = yield* decodeEventRows(
        yield* sql`
        SELECT ordinal, event_id, event_kind, content_hash, payload
        FROM evaluation_events WHERE run_id = ${runId} ORDER BY ordinal
      `,
      )
      const gates = yield* decodeGateRows(
        yield* sql`
        SELECT ordinal, gate_name, passed, actual, required, content_hash
        FROM gate_outcomes WHERE run_id = ${runId} ORDER BY ordinal
      `,
      )
      const statuses = yield* decodeStatusRows(
        yield* sql`
        SELECT status, detail FROM status_history WHERE run_id = ${runId} ORDER BY sequence
      `,
      )
      const trials = yield* decodeTrialRows(
        yield* sql`
        WITH target_lock AS (
          SELECT created_at FROM qualification_locks WHERE candidate_run_id = ${runId}
        )
        SELECT run_id FROM (
          SELECT trial.run_id FROM qualification_trials AS trial CROSS JOIN target_lock
          WHERE trial.observed_at < target_lock.created_at
          UNION
          SELECT result.run_id FROM qualification_results AS result CROSS JOIN target_lock
          WHERE result.committed_at < target_lock.created_at
        ) AS prior_trials ORDER BY run_id
      `,
      )
      const [qualification] = yield* decodeQualificationRow(
        yield* sql`
        SELECT
          to_char(lock.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lock_created_at,
          to_char(result.committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS result_committed_at,
          lock.lock_id, result.analysis_hash, result.result_hash, result.verdict,
          lock.payload AS lock_payload, result.payload AS result_payload
        FROM qualification_locks AS lock
        JOIN qualification_results AS result USING (lock_id)
        WHERE lock.candidate_run_id = ${runId}
      `,
      )
      return {
        transactionReadOnly: readOnly.read_only,
        protocol: {
          protocolHash: run.protocol_hash,
          schemaVersion: run.schema_version,
          strategyName: run.strategy_name,
          behaviorHash: run.behavior_hash,
          parameterHash: run.parameter_hash,
          parameters: run.parameters,
        },
        run: {
          runId: run.run_id,
          protocolHash: run.protocol_hash,
          snapshotId: run.snapshot_id,
          evaluationSchemaVersion: run.evaluation_schema_version,
          sourceRevision: run.source_revision,
          imageRepository: run.image_repository,
          imageDigest: run.image_digest,
          strategyName: run.strategy_name,
          initialCapitalMicros: run.initial_capital_micros,
          status: run.status,
          artifactCount: run.artifact_count,
          eventCount: run.event_count,
          gateCount: run.gate_count,
        },
        artifacts: artifacts.map((row) => ({
          name: row.artifact_name,
          schemaVersion: row.schema_version,
          contentHash: row.content_hash,
          payload: row.payload,
        })),
        events: events.map((row) => ({
          ordinal: row.ordinal,
          id: row.event_id,
          kind: row.event_kind,
          contentHash: row.content_hash,
          payload: row.payload,
        })),
        gates: gates.map((row) => ({
          ordinal: row.ordinal,
          name: row.gate_name,
          passed: row.passed,
          actual: row.actual,
          required: row.required,
          contentHash: row.content_hash,
        })),
        statuses,
        priorTrialRunIds: trials.map((row) => row.run_id),
        qualification: {
          lockCreatedAt: qualification.lock_created_at,
          resultCommittedAt: qualification.result_committed_at,
          storedLockId: qualification.lock_id,
          storedAnalysisHash: qualification.analysis_hash,
          storedResultHash: qualification.result_hash,
          storedVerdict: qualification.verdict,
          lock: qualification.lock_payload,
          result: qualification.result_payload,
        },
      } satisfies AuditDatabaseSnapshot
    }),
  )
})

export const acquireAuditDatabaseClient: AcquireAuditDatabaseClient<FileSystem.FileSystem | Reactivity.Reactivity> = (
  input,
) =>
  readPostgresCertificate(input).pipe(
    Effect.flatMap((ca) =>
      PgClient.make({
        url: input.postgresUrl,
        ssl: ca === undefined ? undefined : { ca, rejectUnauthorized: true },
        applicationName: 'bayn-qualification-audit',
        connectTimeout: input.operationTimeoutMs,
        idleTimeout: '30 seconds',
        maxConnections: 1,
        minConnections: 0,
        transformJson: false,
      }).pipe(
        Effect.mapError((cause) =>
          qualificationAuditCommandError('audit', 'PostgreSQL read-only qualification audit failed', cause),
        ),
      ),
    ),
    Effect.map(
      (sql): AuditDatabaseClient => ({
        read: (runId) =>
          readDatabaseWithClient(sql, runId).pipe(
            Effect.mapError((cause) =>
              qualificationAuditCommandError('audit', 'PostgreSQL read-only qualification audit failed', cause),
            ),
          ),
      }),
    ),
  )

export const readAuditDatabase = <R = FileSystem.FileSystem | Reactivity.Reactivity>(
  input: AuditConfig,
  runId: string,
  acquireClient: AcquireAuditDatabaseClient<R> = acquireAuditDatabaseClient as AcquireAuditDatabaseClient<R>,
): Effect.Effect<AuditDatabaseSnapshot, QualificationAuditCommandError, R> =>
  Effect.scoped(acquireClient(input).pipe(Effect.flatMap((client) => client.read(runId))))
