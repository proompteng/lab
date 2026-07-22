import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { PgClient } from '@effect/sql-pg'
import { Config, Effect, FileSystem, Layer, Logger, Redacted, Schema, Stdio, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { EvaluationEventSchema, decodeInputManifestArtifact } from './evidence-contracts'
import { MarketData, MarketDataLive } from './market-data'
import { ProtocolSchema } from './protocol'
import { QualificationLockSchema, QualificationResultSchema } from './qualification'
import {
  auditQualification,
  type AuditDatabaseSnapshot,
  type RepositoryAudit,
  type SignalAccessRecord,
} from './audit/audit'
import { makeQualificationDossier } from './audit/dossier'
import {
  NonNegativeIntegerSchema as NonNegativeInteger,
  PositiveIntegerSchema as PositiveInteger,
  Sha256Schema as Sha256,
  TrimmedNonEmptyStringSchema as NonEmptyString,
  strictParseOptions as StrictParseOptions,
} from './schemas'
import type { Protocol, InputManifest } from './types'

const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/))
const ReplicaName = NonEmptyString
const GateScalar = Schema.Union([Schema.Finite, Schema.Boolean, Schema.String])
const AuditClickhouseUrls = Config.Array(Schema.URLFromString).check(Schema.isMinLength(2), Schema.isUnique())

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
const AccessRow = Schema.Struct({
  replica: ReplicaName,
  query_id: NonEmptyString,
  query_start_time: IsoInstant,
  user: NonEmptyString,
  kind: Schema.Literals(['manifest', 'sessions', 'bars']),
})
const ReplicaRow = Schema.Struct({ replica: ReplicaName })

const decodeRunRow = Schema.decodeUnknownEffect(Schema.Tuple([RunRow]), StrictParseOptions)
const decodeArtifactRows = Schema.decodeUnknownEffect(Schema.Array(ArtifactRow), StrictParseOptions)
const decodeEventRows = Schema.decodeUnknownEffect(Schema.Array(EventRow), StrictParseOptions)
const decodeGateRows = Schema.decodeUnknownEffect(Schema.Array(GateRow), StrictParseOptions)
const decodeStatusRows = Schema.decodeUnknownEffect(Schema.Array(StatusRow), StrictParseOptions)
const decodeTrialRows = Schema.decodeUnknownEffect(Schema.Array(TrialRow), StrictParseOptions)
const decodeQualificationRow = Schema.decodeUnknownEffect(Schema.Tuple([QualificationRow]), StrictParseOptions)
const decodeReadOnlyRow = Schema.decodeUnknownEffect(Schema.Tuple([ReadOnlyRow]), StrictParseOptions)
const decodeAccessRows = Schema.decodeUnknownEffect(Schema.Array(AccessRow), StrictParseOptions)
const decodeReplicaRow = Schema.decodeUnknownEffect(Schema.Tuple([ReplicaRow]), StrictParseOptions)
const decodeReplicaRows = Schema.decodeUnknownEffect(Schema.Array(ReplicaRow), StrictParseOptions)
const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const config = Config.all({
  output: Config.schema(Schema.Literals(['audit', 'dossier']), 'BAYN_AUDIT_OUTPUT').pipe(Config.withDefault('audit')),
  runId: Config.schema(Sha256, 'BAYN_AUDIT_RUN_ID'),
  postgresUrl: Config.redacted('BAYN_AUDIT_POSTGRES_URL'),
  postgresTls: Config.boolean('BAYN_AUDIT_POSTGRES_TLS').pipe(Config.withDefault(false)),
  postgresCaPath: Config.string('BAYN_AUDIT_POSTGRES_CA_PATH').pipe(Config.withDefault('')),
  signalUrl: Config.string('BAYN_AUDIT_SIGNAL_URL'),
  signalUsername: Config.string('BAYN_AUDIT_SIGNAL_USERNAME'),
  signalPublisherUsername: Config.string('BAYN_AUDIT_SIGNAL_PUBLISHER_USERNAME'),
  signalPassword: Config.redacted('BAYN_AUDIT_SIGNAL_PASSWORD'),
  auditClickhouseUrls: Config.schema(AuditClickhouseUrls, 'BAYN_AUDIT_CLICKHOUSE_URLS'),
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
    if (input.postgresCaPath.length === 0) {
      return yield* Effect.fail(new Error('BAYN_AUDIT_POSTGRES_CA_PATH is required with TLS'))
    }
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

const readDatabase = Effect.fnUntraced(function* (runId: string) {
  const sql = yield* PgClient.PgClient
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
      const [readOnly] = yield* decodeReadOnlyRow(
        yield* sql`SELECT current_setting('transaction_read_only') = 'on' AS read_only`,
      )
      const [run] = yield* decodeRunRow(
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
                (SELECT count(*)::integer FROM evaluation_artifacts WHERE run_id = run.run_id) AS artifact_count,
                (SELECT count(*)::integer FROM evaluation_events WHERE run_id = run.run_id) AS event_count,
                (SELECT count(*)::integer FROM gate_outcomes WHERE run_id = run.run_id) AS gate_count,
                protocol.schema_version,
                protocol.behavior_hash,
                protocol.parameter_hash,
                protocol.parameters
              FROM evaluation_runs AS run
              JOIN protocol_locks AS protocol USING (protocol_hash)
              WHERE run.run_id = ${runId}
            `,
      )
      const artifacts = yield* decodeArtifactRows(
        yield* sql`
            SELECT artifact_name, schema_version, content_hash, payload
            FROM evaluation_artifacts
            WHERE run_id = ${runId}
            ORDER BY artifact_name
          `,
      )
      const events = yield* decodeEventRows(
        yield* sql`
            SELECT ordinal, event_id, event_kind, content_hash, payload
            FROM evaluation_events
            WHERE run_id = ${runId}
            ORDER BY ordinal
          `,
      )
      const gates = yield* decodeGateRows(
        yield* sql`
            SELECT ordinal, gate_name, passed, actual, required, content_hash
            FROM gate_outcomes
            WHERE run_id = ${runId}
            ORDER BY ordinal
          `,
      )
      const statuses = yield* decodeStatusRows(
        yield* sql`
            SELECT status, detail
            FROM status_history
            WHERE run_id = ${runId}
            ORDER BY sequence
          `,
      )
      const trials = yield* decodeTrialRows(
        yield* sql`
            WITH target_lock AS (
              SELECT created_at
              FROM qualification_locks
              WHERE candidate_run_id = ${runId}
            )
            SELECT run_id FROM (
              SELECT trial.run_id
              FROM qualification_trials AS trial
              CROSS JOIN target_lock
              WHERE trial.observed_at < target_lock.created_at
              UNION
              SELECT result.run_id
              FROM qualification_results AS result
              CROSS JOIN target_lock
              WHERE result.committed_at < target_lock.created_at
            ) AS prior_trials
            ORDER BY run_id
          `,
      )
      const [qualification] = yield* decodeQualificationRow(
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

const loadSignal = (input: AuditConfig, manifest: InputManifest, protocol: Protocol) => {
  const marketDataConfig = {
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
  }
  const source = MarketDataLive(marketDataConfig, protocol)
  const layer = source.pipe(
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

interface SignalReplicaAccess {
  readonly replica: string
  readonly topology: readonly string[]
  readonly access: readonly SignalAccessRecord[]
}

const readSignalReplicaAccess = (
  input: AuditConfig,
  url: URL,
  database: AuditDatabaseSnapshot,
  finalizedAt: string,
  manifestTable: InputManifest['tables']['manifests'],
): Effect.Effect<SignalReplicaAccess, unknown> => {
  const program = Effect.gen(function* () {
    const sql = yield* ClickhouseClient.ClickhouseClient
    const [replicaRow] = yield* decodeReplicaRow(
      yield* sql`
          SELECT host_name AS replica
          FROM system.clusters
          WHERE cluster = 'default' AND is_local
        `,
    )
    const replica = replicaRow.replica
    const topology = (yield* decodeReplicaRows(
      yield* sql`
        SELECT host_name AS replica
        FROM system.clusters
        WHERE cluster = 'default'
        ORDER BY shard_num, replica_num
      `,
    )).map((row) => row.replica)
    const rows = yield* sql`
      SELECT
        ${sql.param('String', replica)} AS replica,
        query_id,
        formatDateTime(toTimeZone(query_start_time_microseconds, 'UTC'), '%Y-%m-%dT%H:%i:%S.%fZ') AS query_start_time,
        user,
        multiIf(
          positionCaseInsensitive(query, ${sql.param('String', manifestTable)}) > 0, 'manifest',
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
          positionCaseInsensitive(query, ${sql.param('String', manifestTable)}) > 0
          OR positionCaseInsensitive(query, 'exchange_sessions_v1') > 0
          OR positionCaseInsensitive(query, 'adjusted_daily_bars_v2') > 0
        )
      ORDER BY query_start_time_microseconds, query_id
    `.pipe(sql.withQueryId(`bayn-audit-access-${database.run.runId.slice(-24)}`))
    return {
      replica,
      topology,
      access: (yield* decodeAccessRows(rows)).map((row) => ({
        replica: row.replica,
        queryId: row.query_id,
        queryStartTime: row.query_start_time,
        user: row.user,
        kind: row.kind,
      })),
    }
  })
  return program.pipe(
    Effect.provide(
      ClickhouseClient.layer({
        url: url.href,
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

const readSignalAccess = (
  input: AuditConfig,
  database: AuditDatabaseSnapshot,
  finalizedAt: string,
  manifestTable: InputManifest['tables']['manifests'],
): Effect.Effect<{ readonly replicas: readonly string[]; readonly access: readonly SignalAccessRecord[] }, unknown> =>
  Effect.all(
    input.auditClickhouseUrls.map((url) => readSignalReplicaAccess(input, url, database, finalizedAt, manifestTable)),
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.flatMap((sources) =>
      Effect.try({
        try: () => {
          const observed = sources.map((source) => source.replica).sort()
          if (new Set(observed).size !== observed.length) {
            throw new Error('ClickHouse audit endpoints resolved to duplicate replicas')
          }
          const topology = [...(sources[0]?.topology ?? [])].sort()
          if (topology.length < 2 || new Set(topology).size !== topology.length) {
            throw new Error('ClickHouse audit topology must contain at least two unique replicas')
          }
          if (sources.some((source) => [...source.topology].sort().join('\0') !== topology.join('\0'))) {
            throw new Error('ClickHouse audit endpoints report divergent replica topology')
          }
          if (observed.join('\0') !== topology.join('\0')) {
            throw new Error('ClickHouse audit endpoints do not cover every configured cluster replica')
          }
          if (sources.some((source) => source.access.some((record) => record.replica !== source.replica))) {
            throw new Error('ClickHouse query-log rows do not match their audited replica')
          }
          return { replicas: observed, access: sources.flatMap((source) => source.access) }
        },
        catch: (cause) => cause,
      }),
    ),
  )

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
  if (inputManifestArtifact === undefined) {
    return yield* Effect.fail(new Error('input-manifest artifact is missing'))
  }
  const manifest = yield* decodeInputManifestArtifact(inputManifestArtifact.payload)
  const protocol = database.protocol.parameters
  const signal = yield* loadSignal(input, manifest, protocol)
  const signalAccess = yield* readSignalAccess(
    input,
    database,
    manifest.finalizedSnapshot.finalizedAt,
    manifest.tables.manifests,
  )
  const result = database.qualification.result
  const repository = yield* repositoryAudit(
    input.repositoryPath,
    database.run.sourceRevision,
    database.qualification.lockCreatedAt,
    [database.run.runId, result.resultHash, result.analysis.analysisHash],
  )
  const auditInput = {
    bars: signal.bars,
    manifest: signal.manifest,
    protocol,
    database,
    signalReplicas: signalAccess.replicas,
    signalAccess: signalAccess.access,
    signalPrincipals: { candidate: input.signalUsername, publishers: [input.signalPublisherUsername] },
    repository,
  }
  const report = yield* Effect.try({
    try: () => (input.output === 'dossier' ? makeQualificationDossier(auditInput) : auditQualification(auditInput)),
    catch: (cause) => cause,
  })
  const output = yield* encodeJson(report)
  const stdio = yield* Stdio.Stdio
  yield* Stream.run(Stream.make(`${output}\n`), stdio.stdout())
  if (input.output === 'audit' && 'status' in report && report.status !== 'PASS') {
    return yield* Effect.fail(new Error('qualification audit failed'))
  }
})

const program = main.pipe(
  Effect.annotateLogs({ service: 'bayn-qualification-audit' }),
  Effect.provide(Logger.layer([Logger.consoleJson])),
  Effect.provide(NodeServices.layer),
)

NodeRuntime.runMain(program)
