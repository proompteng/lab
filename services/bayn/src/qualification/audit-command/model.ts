import { Config, Data, Effect, Schema, Scope } from 'effect'

import type { AuditDatabaseSnapshot, RepositoryAudit, SignalAccessRecord } from '../../audit/audit'
import type { MarketDataSnapshot } from '../../market-data'
import { PositiveIntegerSchema as PositiveInteger, Sha256Schema as Sha256 } from '../../schemas'
import type { InputManifest, Protocol } from '../../types'

const AuditClickhouseUrls = Config.Array(Schema.URLFromString).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(8),
  Schema.isUnique(),
)

export const qualificationAuditConfig = Config.all({
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

export type AuditConfig = Config.Success<typeof qualificationAuditConfig>

export class QualificationAuditCommandError extends Data.TaggedError('QualificationAuditCommandError')<{
  readonly operation: 'audit' | 'configuration' | 'repository' | 'signal-access'
  readonly message: string
  readonly cause?: unknown
}> {}

export const qualificationAuditCommandError = (
  operation: QualificationAuditCommandError['operation'],
  message: string,
  cause?: unknown,
): QualificationAuditCommandError => new QualificationAuditCommandError({ operation, message, cause })

export interface AuditDatabaseClient {
  readonly read: (runId: string) => Effect.Effect<AuditDatabaseSnapshot, QualificationAuditCommandError>
}

export type AcquireAuditDatabaseClient<R> = (
  input: AuditConfig,
) => Effect.Effect<AuditDatabaseClient, QualificationAuditCommandError, Scope.Scope | R>

export interface AuditSignalClient {
  readonly load: (
    manifest: InputManifest,
    protocol: Protocol,
  ) => Effect.Effect<MarketDataSnapshot, QualificationAuditCommandError, Scope.Scope>
}

export type AcquireAuditSignalClient<R> = (
  input: AuditConfig,
) => Effect.Effect<AuditSignalClient, QualificationAuditCommandError, Scope.Scope | R>

export interface SignalReplicaAccess {
  readonly replica: string
  readonly topology: readonly string[]
  readonly access: readonly SignalAccessRecord[]
}

export interface AuditSignalReplicaClient {
  readonly url: URL
  readonly read: (
    database: AuditDatabaseSnapshot,
    finalizedAt: string,
    signalTables: InputManifest['tables'],
  ) => Effect.Effect<SignalReplicaAccess, QualificationAuditCommandError>
}

export type AcquireAuditSignalReplicaClient<R> = (
  input: AuditConfig,
  url: URL,
) => Effect.Effect<AuditSignalReplicaClient, QualificationAuditCommandError, Scope.Scope | R>

export interface AuditRepositoryClient {
  readonly audit: (
    sourceRevision: string,
    lockCreatedAt: string,
    resultIdentity: readonly string[],
  ) => Effect.Effect<RepositoryAudit, QualificationAuditCommandError>
}

export type AcquireAuditRepositoryClient<R> = (
  input: AuditConfig,
) => Effect.Effect<AuditRepositoryClient, QualificationAuditCommandError, R>

export interface QualificationAuditReaders<R = never> {
  readonly readDatabase: (runId: string) => Effect.Effect<AuditDatabaseSnapshot, QualificationAuditCommandError, R>
  readonly loadSignal: (
    manifest: InputManifest,
    protocol: Protocol,
  ) => Effect.Effect<MarketDataSnapshot, QualificationAuditCommandError, R>
  readonly readSignalAccess: (
    database: AuditDatabaseSnapshot,
    finalizedAt: string,
    signalTables: InputManifest['tables'],
  ) => Effect.Effect<
    { readonly replicas: readonly string[]; readonly access: readonly SignalAccessRecord[] },
    QualificationAuditCommandError,
    R
  >
  readonly auditRepository: (
    sourceRevision: string,
    lockCreatedAt: string,
    resultIdentity: readonly string[],
  ) => Effect.Effect<RepositoryAudit, QualificationAuditCommandError, R>
}

export interface QualificationAuditAcquirers<R> {
  readonly database: AcquireAuditDatabaseClient<R>
  readonly signal: AcquireAuditSignalClient<R>
  readonly signalReplica: AcquireAuditSignalReplicaClient<R>
  readonly repository: AcquireAuditRepositoryClient<R>
}
