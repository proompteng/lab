import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, Layer, Option, Path, Redacted, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import { postgresMigrations } from '../src/db/postgres-migrations'
import { OntologySyncError, type PreparedAnalysis, verifyReferences } from './sync-auto-ontology-core'

const postgresFailure = (operation: string, message: string, cause: unknown) =>
  new OntologySyncError({ operation, message, cause: Redacted.make(cause) })

const decodeReferences = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ relation: Schema.String })))

export const verifyMigratedAnalyses = (analyses: readonly PreparedAnalysis[]) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // A real PostgreSQL parse resolves columns, CTEs, aliases and views. No analysis is executed.
        yield* sql`SET LOCAL search_path = pg_catalog`
        for (const analysis of analyses) {
          const references = yield* Effect.gen(function* () {
            yield* sql.unsafe(`CREATE TEMP VIEW bayn_ontology_analysis AS ${analysis.viewSql}`)
            const rows = yield* decodeReferences(
              yield* sql`
              SELECT DISTINCT n.nspname || '.' || c.relname AS relation
              FROM pg_rewrite r
              JOIN pg_depend d ON d.objid = r.oid AND d.classid = 'pg_rewrite'::regclass
                AND d.refclassid = 'pg_class'::regclass
              JOIN pg_class c ON c.oid = d.refobjid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE r.ev_class = 'pg_temp.bayn_ontology_analysis'::regclass AND c.oid <> r.ev_class
            `,
            )
            yield* sql`DROP VIEW pg_temp.bayn_ontology_analysis`
            return rows.map(({ relation }) => relation)
          }).pipe(
            Effect.mapError((cause) =>
              postgresFailure(analysis.operation, 'SELECT does not resolve against Bayn migrations', cause),
            ),
          )
          yield* Effect.fromResult(verifyReferences(analysis, references))
        }
      }),
    )
  }).pipe(
    Effect.catchTag('SqlError', (cause) =>
      postgresFailure('migrations', 'Scratch PostgreSQL schema check failed', cause),
    ),
  )

export const checkAnalysesOffline = (analyses: readonly PreparedAnalysis[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'bayn-ontology-' })
    const data = path.join(directory, 'db')
    const user = 'bayn_ontology_check'
    const exit = yield* spawner
      .exitCode(
        ChildProcess.make('initdb', ['-D', data, '-U', user, '--auth=trust', '--no-locale', '--encoding=UTF8'], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        }),
      )
      .pipe(Effect.timeout('30 seconds'))
    if (exit !== 0) {
      return yield* new OntologySyncError({
        operation: 'initdb',
        message: 'Cannot initialize scratch PostgreSQL; run as a non-root user with PostgreSQL 18 on PATH',
      })
    }
    const server = yield* spawner.spawn(
      ChildProcess.make(
        'postgres',
        [
          '-D',
          data,
          '-k',
          directory,
          '-p',
          '5432',
          '-c',
          'listen_addresses=',
          '-c',
          'unix_socket_permissions=0700',
          '-c',
          'log_min_error_statement=panic',
        ],
        { stdin: 'ignore', stdout: 'ignore', killSignal: 'SIGINT', forceKillAfter: '5 seconds' },
      ),
    )
    const ready = yield* server.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.includes('database system is ready to accept connections')),
      Stream.runHead,
      Effect.timeout('15 seconds'),
    )
    if (Option.isNone(ready)) {
      return yield* new OntologySyncError({
        operation: 'postgres',
        message: 'Scratch PostgreSQL stopped before accepting connections',
      })
    }
    const database = yield* Layer.build(
      PgClient.layer({
        path: path.join(directory, '.s.PGSQL.5432'),
        username: user,
        database: 'postgres',
        maxConnections: 1,
        connectTimeout: '5 seconds',
        applicationName: 'bayn-ontology-preflight',
        startupParameters: { statement_timeout: '30s', lock_timeout: '2s' },
      }),
    )
    yield* Effect.andThen(
      postgresMigrations.pipe(
        Effect.mapError((cause) => postgresFailure('migrations', 'Cannot replay Bayn migrations', cause)),
      ),
      verifyMigratedAnalyses(analyses),
    ).pipe(Effect.provideContext(database))
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof OntologySyncError
        ? cause
        : postgresFailure(
            'postgres',
            'Scratch PostgreSQL preflight failed (PostgreSQL 18 initdb and postgres required)',
            cause,
          ),
    ),
    Effect.scoped,
  )
