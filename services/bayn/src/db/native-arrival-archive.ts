import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, Layer, Redacted, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

import nativeArrivalRetention from '../../migrations/0119_native_arrival_retention'
import nativeArrivalAppendLocality from '../../migrations/0142_native_arrival_append_locality'
import type { RuntimeConfig } from '../config/model'
import { databaseError, DatabaseError } from './database-error'
import { PostgresClientLive } from './postgres-client'
import { migrationTimeoutMs, withMigrationDeadline } from './postgres-migrations'

type ArchiveConfig = Pick<RuntimeConfig, 'postgres' | 'nativeArrivalPostgres' | 'operationTimeoutMs'>

export const nativeArrivalArchiveConfig = (config: ArchiveConfig) =>
  Result.gen(function* () {
    const archive = config.nativeArrivalPostgres
    if (archive === undefined)
      return yield* Result.fail(
        databaseError({
          failure: 'invariant',
          operation: 'connect',
          message: 'Native arrival requires its archive database',
        }),
      )
    const endpoint = (url: Redacted.Redacted<string>) =>
      Result.try({
        try: () => {
          const parsed = new URL(Redacted.value(url))
          if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Invalid PostgreSQL URL')
          return [
            parsed.searchParams.getAll('host').at(-1) ??
              (decodeURIComponent(parsed.hostname.replace(/^\[|\]$/g, '')) || 'localhost'),
            parsed.searchParams.getAll('port').at(-1) ?? (parsed.port || '5432'),
          ].join(':')
        },
        catch: () =>
          databaseError({ failure: 'invariant', operation: 'connect', message: 'Invalid archive database URL' }),
      })
    if ((yield* endpoint(archive.url)) === (yield* endpoint(config.postgres.url)))
      return yield* Result.fail(
        databaseError({
          failure: 'invariant',
          operation: 'connect',
          message: 'Native arrival cannot share the financial PostgreSQL endpoint',
        }),
      )
    return { postgres: archive, operationTimeoutMs: config.operationTimeoutMs }
  })

const initialArchive = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE FUNCTION reject_evidence_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='55000'; END
  $$`
  yield* nativeArrivalRetention
})

const archiveMigrations = PgMigrator.fromRecord({
  '1_native_arrival': initialArchive,
  '2_append_locality': nativeArrivalAppendLocality,
})

export const nativeArrivalArchiveMigrations = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql.withTransaction(
    Effect.gen(function* () {
      // PgMigrator probes a missing tracker before locking it. Create it under the same startup lock.
      yield* sql`SELECT pg_advisory_xact_lock(49181, 0)`
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ tablename: Schema.String })))(
        yield* sql`SELECT tablename FROM pg_tables WHERE schemaname='public'
          AND tablename NOT IN ('native_arrival_epochs','native_arrival_chunks','native_arrival_ends','native_arrival_schema_migrations')`,
      )
      if (rows.length > 0)
        return yield* databaseError({
          failure: 'invariant',
          operation: 'migrate',
          message: 'Native arrival archive contains tables from another database role',
        })
      yield* sql`CREATE TABLE IF NOT EXISTS native_arrival_schema_migrations (
        migration_id integer PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        name text NOT NULL
      )`
      yield* PgMigrator.run({ loader: archiveMigrations, table: 'native_arrival_schema_migrations' })
    }),
  )
}).pipe(
  Effect.mapError((cause) =>
    cause instanceof DatabaseError
      ? cause
      : databaseError({
          failure: 'migration',
          operation: 'migrate',
          message: 'Native arrival archive migration failed',
          cause,
        }),
  ),
  Effect.asVoid,
)

export const NativeArrivalArchiveLive = (config: ArchiveConfig) =>
  Layer.unwrap(
    Effect.fromResult(nativeArrivalArchiveConfig(config)).pipe(
      Effect.map((archive) =>
        Layer.effectDiscard(withMigrationDeadline(nativeArrivalArchiveMigrations, migrationTimeoutMs)).pipe(
          Layer.provideMerge(
            PostgresClientLive(archive, { maxConnections: 1, applicationName: 'bayn-native-arrival' }),
          ),
        ),
      ),
    ),
  )
