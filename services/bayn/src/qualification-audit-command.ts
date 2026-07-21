import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { PgClient } from '@effect/sql-pg'
import { Cause, Config, Effect, FileSystem, Layer, Logger, Redacted, Schema, Stdio, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { decodeInputManifestArtifact } from './evidence-contracts'
import { MarketData, MarketDataLive } from './market-data'
import { TsmomProtocolSchema } from './protocol'
import {
  auditQualification,
  type AuditDatabaseSnapshot,
  type RepositoryAudit,
  type SignalAccessRecord,
} from './qualification-audit'
import type { InputManifest, TsmomProtocol } from './types'

const StrictParseOptions = { onExcessProperty: 'error' } as const
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/))

const RunRow = Schema.Struct({
  run_id: Sha256,
  protocol_hash: Sha256,
  snapshot_id: Sha256,
  evaluation_schema_version: Schema.String,
  source_revision: Schema.String,
  image_repository: Schema.String,
  image_digest: Schema.String,
  strategy_name: Schema.String,
  initial_capital_micros: Schema.String,
  status: Schema.String,
  artifact_count: PositiveInteger,
  event_count: NonNegativeInteger,
  gate_count: PositiveInteger,
  schema_version: Schema.String,
  behavior_hash: Sha256,
  parameter_hash: Sha256,
  parameters: Schema.Unknown,
})
const ArtifactRow = Schema.Struct({
  artifact_name: Schema.String,
  schema_version: Schema.String,
  content_hash: Sha256,
  payload: Schema.Unknown,
})
const EventRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  event_id: Sha256,
  event_kind: Schema.String,
  content_hash: Sha256,
  payload: Schema.Unknown,
})
const GateRow = Schema.Struct({
  ordinal: NonNegativeInteger,
  gate_name: Schema.String,
  passed: Schema.Boolean,
  actual: Schema.Unknown,
  required: Schema.Unknown,
  content_hash: Sha256,
})
const StatusRow = Schema.Struct({ status: Schema.String, detail: Schema.Unknown })
const TrialRow = Schema.Struct({ run_id: Sha256 })
const QualificationRow = Schema.Struct({
  lock_created_at: IsoInstant,
  result_committed_at: IsoInstant,
  lock_id: Sha256,
  analysis_hash: Sha256,
  result_hash: Sha256,
  verdict: Schema.Literals(['QUALIFIED', 'REJECTED']),
  lock_payload: Schema.Unknown,
  result_payload: Schema.Unknown,
})
const ReadOnlyRow = Schema.Struct({ read_only: Schema.Boolean })
const AccessRow = Schema.Struct({
  query_id: Schema.String,
  query_start_time: IsoInstant,
  user: Schema.String,
  kind: Schema.Literals(['manifest', 'sessions', 'bars']),
})

const decodeRunRows = Schema.decodeUnknownSync(Schema.Array(RunRow), StrictParseOptions)
const decodeArtifactRows = Schema.decodeUnknownSync(Schema.Array(ArtifactRow), StrictParseOptions)
const decodeEventRows = Schema.decodeUnknownSync(Schema.Array(EventRow), StrictParseOptions)
const decodeGateRows = Schema.decodeUnknownSync(Schema.Array(GateRow), StrictParseOptions)
const decodeStatusRows = Schema.decodeUnknownSync(Schema.Array(StatusRow), StrictParseOptions)
const decodeTrialRows = Schema.decodeUnknownSync(Schema.Array(TrialRow), StrictParseOptions)
const decodeQualificationRows = Schema.decodeUnknownSync(Schema.Array(QualificationRow), StrictParseOptions)
const decodeReadOnlyRows = Schema.decodeUnknownSync(Schema.Array(ReadOnlyRow), StrictParseOptions)
const decodeAccessRows = Schema.decodeUnknownSync(Schema.Array(AccessRow), StrictParseOptions)

const exactlyOne = <A>(values: readonly A[], name: string): A => {
  if (values.length !== 1) throw new Error(`${name} returned ${values.length} rows; expected exactly one`)
  return values[0]
}

const config = Config.all({
  runId: Config.schema(Sha256, 'BAYN_AUDIT_RUN_ID'),
  postgresUrl: Config.redacted('BAYN_AUDIT_POSTGRES_URL'),
  postgresTls: Config.boolean('BAYN_AUDIT_POSTGRES_TLS').pipe(Config.withDefault(false)),
  postgresCaPath: Config.string('BAYN_AUDIT_POSTGRES_CA_PATH').pipe(Config.withDefault('')),
  signalUrl: Config.string('BAYN_AUDIT_SIGNAL_URL'),
  signalUsername: Config.string('BAYN_AUDIT_SIGNAL_USERNAME'),
  signalPublisherUsername: Config.string('BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME'),
  signalPassword: Config.redacted('BAYN_AUDIT_SIGNAL_PASSWORD'),
  auditClickhouseUrl: Config.string('BAYN_AUDIT_CLICKHOUSE_URL'),
  auditClickhouseUsername: Config.string('BAYN_AUDIT_CLICKHOUSE_USERNAME'),
  auditClickhousePassword: Config.redacted('BAYN_AUDIT_CLICKHOUSE_PASSWORD'),
  repositoryPath: Config.string('BAYN_AUDIT_REPOSITORY_PATH').pipe(Config.withDefault('.')),
  operationTimeoutMs: Config.schema(PositiveInteger, 'BAYN_AUDIT_OPERATION_TIMEOUT_MS').pipe(
    Config.withDefault(60_000),
  ),
})

type AuditConfig = Config.Success<typeof config>

const postgresLayer = (input: AuditConfig) => {
  const readCertificate = Effect.gen(function* () {
    if (!input.postgresTls) return undefined
    if (input.postgresCaPath.length === 0) throw new Error('BAYN_AUDIT_POSTGRES_CA_PATH is required with TLS')
    const fileSystem = yield* FileSystem.FileSystem
    return yield* fileSystem.readFileString(input.postgresCaPath)
  })
  return Layer.unwrap(
    readCertificate.pipe(
      Effect.map((ca) =>
        PgClient.layerFrom(
          PgClient.make({
            url: input.postgresUrl,
            ssl: ca === undefined ? undefined : { ca, rejectUnauthorized: true },
            applicationName: 'bayn-qualification-audit',
            connectTimeout: input.operationTimeoutMs,
            idleTimeout: '30 seconds',
            maxConnections: 1,
            minConnections: 0,
            transformJson: false,
          }),
        ),
      ),
    ),
  )
}

const readDatabase = (runId: string): Effect.Effect<AuditDatabaseSnapshot, unknown, PgClient.PgClient> =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
        const readOnly = exactlyOne(
          decodeReadOnlyRows(yield* sql`SELECT current_setting('transaction_read_only') = 'on' AS read_only`),
          'transaction mode',
        )
        const run = exactlyOne(
          decodeRunRows(
            yield* sql`
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
                (SELECT count(*)::integer FROM bayn_evaluation_artifacts WHERE run_id = run.run_id) AS artifact_count,
                (SELECT count(*)::integer FROM bayn_evaluation_events WHERE run_id = run.run_id) AS event_count,
                (SELECT count(*)::integer FROM bayn_gate_outcomes WHERE run_id = run.run_id) AS gate_count,
                protocol.schema_version,
                protocol.behavior_hash,
                protocol.parameter_hash,
                protocol.parameters
              FROM bayn_evaluation_runs AS run
              JOIN bayn_protocol_locks AS protocol USING (protocol_hash)
              WHERE run.run_id = ${runId}
            `,
          ),
          'evaluation run',
        )
        const artifacts = decodeArtifactRows(
          yield* sql`
            SELECT artifact_name, schema_version, content_hash, payload
            FROM bayn_evaluation_artifacts
            WHERE run_id = ${runId}
            ORDER BY artifact_name
          `,
        )
        const events = decodeEventRows(
          yield* sql`
            SELECT ordinal, event_id, event_kind, content_hash, payload
            FROM bayn_evaluation_events
            WHERE run_id = ${runId}
            ORDER BY ordinal
          `,
        )
        const gates = decodeGateRows(
          yield* sql`
            SELECT ordinal, gate_name, passed, actual, required, content_hash
            FROM bayn_gate_outcomes
            WHERE run_id = ${runId}
            ORDER BY ordinal
          `,
        )
        const statuses = decodeStatusRows(
          yield* sql`
            SELECT status, detail
            FROM bayn_status_history
            WHERE run_id = ${runId}
            ORDER BY sequence
          `,
        )
        const trials = decodeTrialRows(
          yield* sql`
            SELECT run_id
            FROM bayn_qualification_trials
            WHERE observed_at < (
              SELECT created_at FROM bayn_qualification_locks WHERE candidate_run_id = ${runId}
            )
            ORDER BY run_id
          `,
        )
        const qualification = exactlyOne(
          decodeQualificationRows(
            yield* sql`
              SELECT
                to_char(lock.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lock_created_at,
                to_char(result.committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS result_committed_at,
                lock.lock_id,
                result.analysis_hash,
                result.result_hash,
                result.verdict,
                lock.payload AS lock_payload,
                result.payload AS result_payload
              FROM bayn_qualification_locks AS lock
              JOIN bayn_qualification_results AS result USING (lock_id)
              WHERE lock.candidate_run_id = ${runId}
            `,
          ),
          'terminal qualification',
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
        }
      }),
    )
  })

const loadSignal = (
  input: AuditConfig,
  database: AuditDatabaseSnapshot,
  manifest: InputManifest,
  protocol: TsmomProtocol,
) => {
  const layer = MarketDataLive(
    {
      operationTimeoutMs: input.operationTimeoutMs,
      clickhouse: {
        url: input.signalUrl,
        username: input.signalUsername,
        password: input.signalPassword,
        snapshotId: manifest.finalizedSnapshot.snapshotId,
        publicationAsOf: manifest.finalizedSnapshot.asOfSession,
        calendarVersion: manifest.finalizedSnapshot.calendarVersion,
        bounds: manifest.bounds,
      },
    },
    protocol.universe,
  ).pipe(
    Layer.provide(
      ClickhouseClient.layer({
        url: input.signalUrl,
        username: input.signalUsername,
        password: Redacted.value(input.signalPassword),
        database: 'signal',
        application: 'bayn-qualification-audit',
        request_timeout: input.operationTimeoutMs,
      }),
    ),
    Layer.provide(NodeHttpClient.layerNodeHttp),
  )
  return MarketData.pipe(
    Effect.flatMap((marketData) => marketData.load),
    Effect.provide(layer),
  )
}

const readSignalAccess = (
  input: AuditConfig,
  database: AuditDatabaseSnapshot,
  finalizedAt: string,
): Effect.Effect<readonly SignalAccessRecord[], unknown> => {
  const program = Effect.gen(function* () {
    const sql = yield* ClickhouseClient.ClickhouseClient
    const rows = yield* sql`
      SELECT
        query_id,
        formatDateTime(toTimeZone(query_start_time_microseconds, 'UTC'), '%Y-%m-%dT%H:%i:%S.%fZ') AS query_start_time,
        user,
        multiIf(
          positionCaseInsensitive(query, 'snapshot_manifests_v1') > 0, 'manifest',
          positionCaseInsensitive(query, 'exchange_sessions_v1') > 0, 'sessions',
          'bars'
        ) AS kind
      FROM system.query_log
      WHERE type = 'QueryStart'
        AND query_start_time_microseconds >= parseDateTime64BestEffort(${sql.param('String', finalizedAt)}, 6)
        AND query_start_time_microseconds <= parseDateTime64BestEffort(
          ${sql.param('String', database.qualification.resultCommittedAt)},
          6
        )
        AND position(query, ${sql.param('String', database.run.snapshotId)}) > 0
        AND (
          positionCaseInsensitive(query, 'snapshot_manifests_v1') > 0
          OR positionCaseInsensitive(query, 'exchange_sessions_v1') > 0
          OR positionCaseInsensitive(query, 'adjusted_daily_bars_v2') > 0
        )
      ORDER BY query_start_time_microseconds, query_id
    `.pipe(sql.withQueryId(`bayn-audit-access-${database.run.runId.slice(-24)}`))
    return decodeAccessRows(rows).map((row) => ({
      queryId: row.query_id,
      queryStartTime: row.query_start_time,
      user: row.user,
      kind: row.kind,
    }))
  })
  return program.pipe(
    Effect.provide(
      ClickhouseClient.layer({
        url: input.auditClickhouseUrl,
        username: input.auditClickhouseUsername,
        password: Redacted.value(input.auditClickhousePassword),
        database: 'system',
        application: 'bayn-qualification-audit',
        request_timeout: input.operationTimeoutMs,
      }),
    ),
    Effect.provide(NodeHttpClient.layerNodeHttp),
  )
}

const repositoryAudit = (
  repositoryPath: string,
  sourceRevision: string,
  lockCreatedAt: string,
  resultIdentity: readonly string[],
): Effect.Effect<RepositoryAudit, unknown, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner
    const exists = yield* processes.exitCode(
      ChildProcess.make('git', ['-C', repositoryPath, 'cat-file', '-e', `${sourceRevision}^{commit}`]),
    )
    const ancestor = yield* processes.exitCode(
      ChildProcess.make('git', ['-C', repositoryPath, 'merge-base', '--is-ancestor', sourceRevision, 'origin/main']),
    )
    const pattern = resultIdentity.join('|')
    const lines = yield* processes.lines(
      ChildProcess.make('git', [
        '-C',
        repositoryPath,
        'log',
        'origin/main',
        `--before=${lockCreatedAt}`,
        '--format=%H',
        `-G${pattern}`,
      ]),
    )
    const references = new Set(lines.filter((line) => /^[0-9a-f]{40}$/.test(line)))
    return {
      sourceCommitExists: Number(exists) === 0,
      sourceCommitAncestorOfMain: Number(ancestor) === 0,
      preLockResultReferences: [...references].sort(),
    }
  })

const main = Effect.gen(function* () {
  const input = yield* config
  const database = yield* readDatabase(input.runId).pipe(Effect.provide(postgresLayer(input)))
  const inputManifestArtifact = database.artifacts.find((artifact) => artifact.name === 'input-manifest')
  if (inputManifestArtifact === undefined) throw new Error('input-manifest artifact is missing')
  const manifest = yield* decodeInputManifestArtifact(inputManifestArtifact.payload)
  const protocol = yield* Schema.decodeUnknownEffect(
    TsmomProtocolSchema,
    StrictParseOptions,
  )(database.protocol.parameters)
  const signal = yield* loadSignal(input, database, manifest, protocol)
  const signalAccess = yield* readSignalAccess(input, database, manifest.finalizedSnapshot.finalizedAt)
  const result = database.qualification.result as Readonly<Record<string, unknown>>
  const analysis = result.analysis as Readonly<Record<string, unknown>>
  const repository = yield* repositoryAudit(
    input.repositoryPath,
    database.run.sourceRevision,
    database.qualification.lockCreatedAt,
    [database.run.runId, String(result.resultHash), String(analysis.analysisHash)],
  )
  const report = auditQualification({
    bars: signal.bars,
    manifest: signal.manifest,
    protocol,
    database,
    signalAccess,
    signalPrincipals: { candidate: input.signalUsername, publishers: [input.signalPublisherUsername] },
    repository,
  })
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(`${JSON.stringify(report)}\n`), stdio.stdout())
  if (report.status !== 'PASS') return yield* Effect.fail(new Error('qualification audit failed'))
})

const program = main.pipe(
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.logError('Bayn qualification audit failed').pipe(
          Effect.annotateLogs({ service: 'bayn-qualification-audit', cause: Cause.pretty(cause) }),
        ),
  ),
  Effect.provide(Logger.layer([Logger.consoleJson])),
  Effect.provide(NodeServices.layer),
)

NodeRuntime.runMain(program, { disableErrorReporting: true })
