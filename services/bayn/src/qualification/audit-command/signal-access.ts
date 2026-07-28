import { ClickhouseClient } from '@effect/sql-clickhouse'
import { Effect, Redacted, Result, Schema } from 'effect'
import * as Reactivity from 'effect/unstable/reactivity/Reactivity'

import {
  classifySignalTableAccess,
  validateSignalReplicaTopology,
  type AuditDatabaseSnapshot,
  type SignalAccessRecord,
} from '../../audit/audit'
import { TrimmedNonEmptyStringSchema as NonEmptyString, strictParseOptions } from '../../schemas'
import type { InputManifest } from '../../types'
import {
  qualificationAuditCommandError,
  type AcquireAuditSignalReplicaClient,
  type AuditConfig,
  type AuditSignalReplicaClient,
  type QualificationAuditCommandError,
  type SignalReplicaAccess,
} from './model'

const IsoInstant = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/))
const AccessRow = Schema.Struct({
  replica: NonEmptyString,
  query_id: NonEmptyString,
  query_start_time: IsoInstant,
  user: NonEmptyString,
  tables: Schema.Array(NonEmptyString),
})
const ReplicaRow = Schema.Struct({ replica: NonEmptyString })
const decodeAccessRows = Schema.decodeUnknownEffect(Schema.Array(AccessRow), strictParseOptions)
const decodeReplicaRow = Schema.decodeUnknownEffect(Schema.Tuple([ReplicaRow]), strictParseOptions)
const decodeReplicaRows = Schema.decodeUnknownEffect(Schema.Array(ReplicaRow), strictParseOptions)

const readSignalReplicaAccessWithClient = (
  url: URL,
  database: AuditDatabaseSnapshot,
  finalizedAt: string,
  signalTables: InputManifest['tables'],
  sql: ClickhouseClient.ClickhouseClient,
): Effect.Effect<SignalReplicaAccess, QualificationAuditCommandError> => {
  const barsTable = `signal.${signalTables.bars}`
  const sessionsTable = `signal.${signalTables.sessions}`
  const manifestTable = `signal.${signalTables.manifests}`
  return Effect.gen(function* () {
    const [replicaRow] = yield* decodeReplicaRow(
      yield* sql`
      SELECT host_name AS replica FROM system.clusters WHERE cluster = 'default' AND is_local
    `,
    )
    const replica = replicaRow.replica
    const topology = (yield* decodeReplicaRows(
      yield* sql`
      SELECT host_name AS replica FROM system.clusters
      WHERE cluster = 'default' ORDER BY shard_num, replica_num
    `,
    )).map((row) => row.replica)
    const rows = yield* sql`
      SELECT
        ${sql.param('String', replica)} AS replica,
        query_id,
        formatDateTime(toTimeZone(query_start_time_microseconds, 'UTC'), '%Y-%m-%dT%H:%i:%S.%fZ') AS query_start_time,
        user,
        tables
      FROM system.query_log
      WHERE type = 'QueryStart'
        AND query_start_time_microseconds >= parseDateTime64BestEffort(${sql.param('String', finalizedAt)}, 6)
        AND query_start_time_microseconds <= parseDateTime64BestEffort(
          ${sql.param('String', database.qualification.resultCommittedAt)},
          6
        )
        AND position(query, ${sql.param('String', database.run.snapshotId)}) > 0
        AND (
          has(tables, ${sql.param('String', manifestTable)})
          OR has(tables, ${sql.param('String', sessionsTable)})
          OR has(tables, ${sql.param('String', barsTable)})
        )
      ORDER BY query_start_time_microseconds, query_id
    `.pipe(sql.withQueryId(`bayn-audit-access-${database.run.runId.slice(-24)}`))
    const access: SignalAccessRecord[] = []
    for (const row of yield* decodeAccessRows(rows)) {
      const classification = classifySignalTableAccess(row.tables, signalTables)
      if (Result.isFailure(classification)) {
        return yield* Effect.fail(
          qualificationAuditCommandError(
            'signal-access',
            'ClickHouse query-log row has no Signal evidence table',
            classification.failure,
          ),
        )
      }
      access.push({
        replica: row.replica,
        queryId: row.query_id,
        queryStartTime: row.query_start_time,
        user: row.user,
        kind: classification.success,
      })
    }
    return { replica, topology, access }
  }).pipe(
    Effect.mapError((cause) =>
      qualificationAuditCommandError(
        'signal-access',
        `ClickHouse replica audit read failed for ${url.hostname}`,
        cause,
      ),
    ),
  )
}

export const acquireAuditSignalReplicaClient: AcquireAuditSignalReplicaClient<Reactivity.Reactivity> = (input, url) =>
  ClickhouseClient.make({
    url: url.href,
    username: input.auditClickhouseUsername,
    password: Redacted.value(input.auditClickhousePassword),
    database: 'system',
    application: 'bayn-qualification-audit',
    request_timeout: input.operationTimeoutMs,
  }).pipe(
    Effect.mapError((cause) =>
      qualificationAuditCommandError('signal-access', 'ClickHouse replica audit read failed', cause),
    ),
    Effect.map(
      (sql): AuditSignalReplicaClient => ({
        url,
        read: (database, finalizedAt, signalTables) =>
          readSignalReplicaAccessWithClient(url, database, finalizedAt, signalTables, sql),
      }),
    ),
  )

const readSignalAccessWithClients = (
  database: AuditDatabaseSnapshot,
  finalizedAt: string,
  signalTables: InputManifest['tables'],
  clients: readonly AuditSignalReplicaClient[],
): Effect.Effect<
  { readonly replicas: readonly string[]; readonly access: readonly SignalAccessRecord[] },
  QualificationAuditCommandError
> =>
  Effect.all(
    clients.map((client) => client.read(database, finalizedAt, signalTables)),
    { concurrency: Math.min(clients.length, 4) },
  ).pipe(
    Effect.flatMap((sources) =>
      Effect.fromResult(validateSignalReplicaTopology(sources)).pipe(
        Effect.mapError((cause) =>
          qualificationAuditCommandError('signal-access', 'ClickHouse replica audit topology is invalid', cause),
        ),
      ),
    ),
  )

export const readAuditSignalAccess = <R = Reactivity.Reactivity>(
  input: AuditConfig,
  database: AuditDatabaseSnapshot,
  finalizedAt: string,
  signalTables: InputManifest['tables'],
  acquireClient: AcquireAuditSignalReplicaClient<R> = acquireAuditSignalReplicaClient as AcquireAuditSignalReplicaClient<R>,
): Effect.Effect<
  { readonly replicas: readonly string[]; readonly access: readonly SignalAccessRecord[] },
  QualificationAuditCommandError,
  R
> =>
  Effect.scoped(
    Effect.forEach(input.auditClickhouseUrls, (url) => acquireClient(input, url), {
      concurrency: Math.min(input.auditClickhouseUrls.length, 4),
    }).pipe(Effect.flatMap((clients) => readSignalAccessWithClients(database, finalizedAt, signalTables, clients))),
  )
