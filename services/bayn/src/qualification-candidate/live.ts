import type { ConnectionOptions } from 'node:tls'

import { ClickhouseClient } from '@effect/sql-clickhouse'
import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, PlatformError, Redacted, Scope } from 'effect'

import { makeMarketData } from '../market-data'
import type { IsoDate } from '../schemas'
import type { CausalProtocol } from '../types'
import type { QualificationCandidateFailure } from './failure'
import {
  type CandidateConfig,
  type CandidateReplicaEndpoint,
  type CandidateReplicaObservation,
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

const makeCandidateClickhouse = (
  input: QualificationCandidateInput,
  endpoint: CandidateReplicaEndpoint,
  password: Redacted.Redacted<string>,
  operationTimeoutMs: number,
) =>
  ClickhouseClient.make({
    url: endpoint.href,
    username: input.publisherPrincipal,
    password: Redacted.value(password),
    database: 'signal',
    application: 'bayn-qualification-candidate',
    request_timeout: operationTimeoutMs,
    clickhouse_settings: { readonly: '1' },
  })

export interface CandidateReplicaClient<R, E> {
  readonly read: Effect.Effect<CandidateReplicaObservation, E, R>
}

export type AcquireCandidateReplicaClient<AcquireR, ReadR, AcquireError, ReadError> = (
  input: QualificationCandidateInput,
  endpoint: CandidateReplicaEndpoint,
  password: Redacted.Redacted<string>,
  operationTimeoutMs: number,
) => Effect.Effect<CandidateReplicaClient<ReadR, ReadError>, AcquireError, Scope.Scope | AcquireR>

export const acquireCandidateReplicaClient = (
  input: QualificationCandidateInput,
  endpoint: CandidateReplicaEndpoint,
  password: Redacted.Redacted<string>,
  operationTimeoutMs: number,
) =>
  makeCandidateClickhouse(input, endpoint, password, operationTimeoutMs).pipe(
    Effect.map((sql) => ({
      read: Effect.gen(function* () {
        const {
          identityRows: [identity],
          candidateRows: [candidate],
        } = yield* Effect.all(
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
              `.pipe(
              sql.withQueryId(`bayn-candidate-select-${input.publicationDate}`),
              Effect.flatMap(decodeCandidateRows),
            ),
          },
          { concurrency: 1 },
        )
        const marketData = yield* makeMarketData(
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
        ).pipe(Effect.provideService(ClickhouseClient.ClickhouseClient, sql))
        const snapshot = yield* marketData.loadSnapshotPublication({
          snapshotId: candidate.snapshot_id,
          signalSessionDate: input.publicationDate,
          signalCalendarVersion: candidate.calendar_version,
        })
        return {
          endpointHost: endpoint.hostname,
          replica: identity.replica,
          principal: identity.principal,
          snapshot,
        }
      }),
    })),
  )

const readCandidateReplicaWith = <AcquireR, ReadR, AcquireError, ReadError>(
  input: QualificationCandidateInput,
  endpoint: CandidateReplicaEndpoint,
  password: Redacted.Redacted<string>,
  operationTimeoutMs: number,
  acquireClient: AcquireCandidateReplicaClient<AcquireR, ReadR, AcquireError, ReadError>,
): Effect.Effect<CandidateReplicaObservation, QualificationCandidateFailure, Exclude<AcquireR | ReadR, Scope.Scope>> =>
  Effect.scoped(
    acquireClient(input, endpoint, password, operationTimeoutMs).pipe(Effect.flatMap((client) => client.read)),
  ).pipe(
    Effect.mapError(
      (cause): QualificationCandidateFailure => ({
        _tag: 'ReplicaReadFailed',
        endpointHost: endpoint.hostname,
        cause,
      }),
    ),
  )

export const readCandidateReplica = <AcquireR, ReadR, AcquireError, ReadError>(
  input: QualificationCandidateInput,
  endpoint: CandidateReplicaEndpoint,
  password: Redacted.Redacted<string>,
  operationTimeoutMs: number,
  acquireClient: AcquireCandidateReplicaClient<AcquireR, ReadR, AcquireError, ReadError>,
): Effect.Effect<CandidateReplicaObservation, QualificationCandidateFailure, Exclude<AcquireR | ReadR, Scope.Scope>> =>
  readCandidateReplicaWith(input, endpoint, password, operationTimeoutMs, acquireClient)

const postgresSsl = (
  input: CandidateConfig,
): Effect.Effect<ConnectionOptions | undefined, PlatformError.PlatformError, FileSystem.FileSystem> => {
  const tls = input.postgresTls
  if (tls === undefined) return Effect.void.pipe(Effect.as(undefined))
  return Effect.flatMap(FileSystem.FileSystem, (fileSystem) =>
    fileSystem.readFileString(tls.caPath).pipe(Effect.map((ca) => makeCandidatePostgresSslOptions(tls.serverName, ca))),
  )
}

const makeCandidatePostgres = (input: CandidateConfig) =>
  postgresSsl(input).pipe(
    Effect.flatMap((ssl) =>
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
  )

export interface QualificationLockClient<R, E> {
  readonly read: (snapshotId: string) => Effect.Effect<QualificationLockObservation, E, Scope.Scope | R>
}

export type AcquireQualificationLockClient<R, AcquireError, ReadError> = (
  input: CandidateConfig,
) => Effect.Effect<QualificationLockClient<R, ReadError>, AcquireError, Scope.Scope | R>

export const acquireQualificationLockClient = (input: CandidateConfig) =>
  makeCandidatePostgres(input).pipe(
    Effect.map((sql) => ({
      read: (snapshotId: string) =>
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
    })),
  )

const readQualificationLocksWith = <R, AcquireError, ReadError>(
  input: CandidateConfig,
  snapshotId: string,
  acquireClient: AcquireQualificationLockClient<R, AcquireError, ReadError>,
): Effect.Effect<QualificationLockObservation, QualificationCandidateFailure, R> =>
  Effect.scoped(acquireClient(input).pipe(Effect.flatMap((client) => client.read(snapshotId)))).pipe(
    Effect.mapError((cause): QualificationCandidateFailure => ({ _tag: 'PostgresReadFailed', cause })),
  )

export const readQualificationLocks = <R, AcquireError, ReadError>(
  input: CandidateConfig,
  snapshotId: string,
  acquireClient: AcquireQualificationLockClient<R, AcquireError, ReadError>,
): Effect.Effect<QualificationLockObservation, QualificationCandidateFailure, R> =>
  readQualificationLocksWith(input, snapshotId, acquireClient)
