import type { ConnectionOptions } from 'node:tls'

import { NodeHttpClient } from '@effect/platform-node'
import { ClickhouseClient } from '@effect/sql-clickhouse'
import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, Layer, PlatformError, Redacted } from 'effect'

import { MarketData, MarketDataLive } from '../market-data'
import type { IsoDate } from '../schemas'
import type { CausalProtocol } from '../types'
import {
  type CandidateConfig,
  type CandidateReplicaEndpoint,
  type CandidateReplicaObservation,
  type QualificationCandidateFailure,
  type QualificationCandidateInput,
  type QualificationLockObservation,
} from './model'
import { decodeCandidateRows, decodeLockCountRows, decodeReadOnlyRows, decodeReplicaIdentityRows } from './schema'

export const makeCandidatePostgresSslOptions = (serverName: string, ca: string): ConnectionOptions => ({
  ca,
  rejectUnauthorized: true,
  servername: serverName,
})

const candidateBounds = (protocol: CausalProtocol, publicationDate: IsoDate) => ({
  schemaVersion: 'bayn.evaluation-bounds.v1' as const,
  dataStart: protocol.historyStart,
  dataEnd: publicationDate,
  lookbackStart: protocol.historyStart,
  evaluationStart: protocol.evaluationStart,
  evaluationEnd: publicationDate,
})

const clickhouseLayer = (
  input: QualificationCandidateInput,
  endpoint: CandidateReplicaEndpoint,
  password: Redacted.Redacted<string>,
  operationTimeoutMs: number,
) =>
  ClickhouseClient.layer({
    url: endpoint.href,
    username: input.publisherPrincipal,
    password: Redacted.value(password),
    database: 'signal',
    application: 'bayn-qualification-candidate',
    request_timeout: operationTimeoutMs,
    clickhouse_settings: { readonly: '1' },
  }).pipe(Layer.provide(NodeHttpClient.layerNodeHttp))

export const readCandidateReplica = (
  input: QualificationCandidateInput,
  endpoint: CandidateReplicaEndpoint,
  password: Redacted.Redacted<string>,
  operationTimeoutMs: number,
): Effect.Effect<CandidateReplicaObservation, QualificationCandidateFailure> =>
  Effect.flatMap(ClickhouseClient.ClickhouseClient, (sql) =>
    Effect.all(
      {
        identityRows: sql`
          SELECT hostName() AS replica, currentUser() AS principal
        `.pipe(sql.withQueryId('bayn-candidate-replica-identity'), Effect.flatMap(decodeReplicaIdentityRows)),
        candidateRows: sql`
          SELECT snapshot_id, calendar_version
          FROM signal.snapshot_manifests_v2
          WHERE universe_id = ${sql.param('String', input.protocol.universeId)}
            AND universe_symbol_hash = ${sql.param('String', input.protocol.universeSymbolHash)}
            AND requested_start = toDate(${sql.param('String', input.protocol.historyStart)})
            AND publication_asof = toDate(${sql.param('String', input.publicationDate)})
          ORDER BY finalized_at DESC, snapshot_id DESC
          LIMIT 1
        `.pipe(sql.withQueryId(`bayn-candidate-select-${input.publicationDate}`), Effect.flatMap(decodeCandidateRows)),
      },
      { concurrency: 1 },
    ).pipe(
      Effect.flatMap(({ identityRows: [identity], candidateRows: [candidate] }) =>
        MarketData.pipe(
          Effect.provide(
            MarketDataLive(
              {
                operationTimeoutMs,
                clickhouse: {
                  url: endpoint.href,
                  username: input.publisherPrincipal,
                  password,
                  snapshotId: candidate.snapshot_id,
                  publicationAsOf: input.publicationDate,
                  calendarVersion: candidate.calendar_version,
                  bounds: candidateBounds(input.protocol, input.publicationDate),
                },
              },
              input.protocol,
            ),
          ),
          Effect.flatMap((marketData) =>
            marketData
              .loadSnapshotPublication({
                snapshotId: candidate.snapshot_id,
                signalSessionDate: input.publicationDate,
                signalCalendarVersion: candidate.calendar_version,
              })
              .pipe(
                Effect.map((snapshot) => ({
                  endpointHost: endpoint.hostname,
                  replica: identity.replica,
                  principal: identity.principal,
                  snapshot,
                })),
              ),
          ),
        ),
      ),
    ),
  ).pipe(
    Effect.provide(clickhouseLayer(input, endpoint, password, operationTimeoutMs)),
    Effect.mapError(
      (cause): QualificationCandidateFailure => ({
        _tag: 'ReplicaReadFailed',
        endpointHost: endpoint.hostname,
        cause,
      }),
    ),
  )

const postgresSsl = (
  input: CandidateConfig,
): Effect.Effect<ConnectionOptions | undefined, PlatformError.PlatformError, FileSystem.FileSystem> => {
  const tls = input.postgresTls
  if (tls === undefined) return Effect.succeed(undefined)
  return Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.readFileString(tls.caPath).pipe(Effect.map((ca) => makeCandidatePostgresSslOptions(tls.serverName, ca))),
  )
}

const postgresLayer = (input: CandidateConfig) =>
  Layer.unwrap(
    postgresSsl(input).pipe(
      Effect.map((ssl) =>
        PgClient.layerFrom(
          PgClient.make({
            url: input.postgresUrl,
            ssl,
            applicationName: 'bayn-qualification-candidate',
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

export const readQualificationLocks = (
  input: CandidateConfig,
  snapshotId: string,
): Effect.Effect<QualificationLockObservation, QualificationCandidateFailure, FileSystem.FileSystem> =>
  Effect.flatMap(PgClient.PgClient, (sql) =>
    sql.withTransaction(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.pipe(
        Effect.flatMap(() =>
          Effect.all(
            {
              readOnlyRows: sql`SELECT current_setting('transaction_read_only') = 'on' AS read_only`.pipe(
                Effect.flatMap(decodeReadOnlyRows),
              ),
              countRows: sql`
                SELECT count(*)::integer AS lock_count
                FROM qualification_locks
                WHERE snapshot_id = ${snapshotId}
              `.pipe(Effect.flatMap(decodeLockCountRows)),
            },
            { concurrency: 1 },
          ),
        ),
        Effect.map(({ readOnlyRows: [readOnly], countRows: [count] }) => ({
          transactionReadOnly: readOnly.read_only,
          count: count.lock_count,
        })),
      ),
    ),
  ).pipe(
    Effect.provide(postgresLayer(input)),
    Effect.mapError((cause): QualificationCandidateFailure => ({ _tag: 'PostgresReadFailed', cause })),
  )
