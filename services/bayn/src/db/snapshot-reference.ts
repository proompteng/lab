import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { canonicalHashV1Result, renderCanonicalJsonFailure, type CanonicalJsonFailure } from '../hash'
import { strictParseOptions } from '../schemas'
import type { InputManifest } from '../types'

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const SnapshotReferenceRowSchema = Schema.Struct({
  snapshot_id: Schema.String,
  schema_version: Schema.Literal('bayn.finalized-snapshot.v3'),
  database_name: Schema.Literal('signal'),
  table_name: Schema.Literal('adjusted_daily_bars_v2'),
  dataset_version: Schema.Literal('signal.adjusted-daily-snapshot.v2'),
  source: Schema.Literal('alpaca'),
  source_feed: Schema.Literal('sip'),
  adjustment: Schema.Literal('all'),
  content_hash: Schema.String,
  row_count: PositiveInteger,
  first_session: Schema.String,
  last_session: Schema.String,
  manifest: Schema.Json,
})

export type SnapshotReferenceRow = typeof SnapshotReferenceRowSchema.Type

type SnapshotReferencePath = readonly [string, ...(number | string)[]]

export type SnapshotReferenceIssue =
  | {
      readonly _tag: 'SnapshotReferenceCardinalityMismatch'
      readonly snapshotId: string
      readonly observedCount: number
      readonly expectedCount: 1
    }
  | {
      readonly _tag: 'SnapshotReferenceMismatch'
      readonly path: SnapshotReferencePath
      readonly observed: unknown
      readonly expected: unknown
    }
  | {
      readonly _tag: 'SnapshotReferenceCanonicalizationFailed'
      readonly subject: 'stored-manifest' | 'input-manifest'
      readonly cause: CanonicalJsonFailure
    }

const decodeSnapshotReferenceRows = Schema.decodeUnknownEffect(
  Schema.Array(SnapshotReferenceRowSchema),
  strictParseOptions,
)

const mismatch = (
  path: SnapshotReferencePath,
  observed: unknown,
  expected: unknown,
): Result.Result<never, SnapshotReferenceIssue> =>
  Result.fail({ _tag: 'SnapshotReferenceMismatch', path, observed, expected })

const manifestHash = (
  subject: 'stored-manifest' | 'input-manifest',
  value: unknown,
): Result.Result<string, SnapshotReferenceIssue> =>
  Result.mapError(
    canonicalHashV1Result(value),
    (cause): SnapshotReferenceIssue => ({
      _tag: 'SnapshotReferenceCanonicalizationFailed',
      subject,
      cause,
    }),
  )

export const validateSnapshotReference = (
  inputManifest: InputManifest,
  rows: readonly SnapshotReferenceRow[],
): Result.Result<void, SnapshotReferenceIssue> =>
  Result.gen(function* () {
    const snapshot = inputManifest.finalizedSnapshot
    if (rows.length !== 1) {
      return yield* Result.fail({
        _tag: 'SnapshotReferenceCardinalityMismatch',
        snapshotId: snapshot.snapshotId,
        observedCount: rows.length,
        expectedCount: 1,
      } satisfies SnapshotReferenceIssue)
    }
    const row = rows[0]
    if (row === undefined) {
      return yield* Result.fail({
        _tag: 'SnapshotReferenceCardinalityMismatch',
        snapshotId: snapshot.snapshotId,
        observedCount: 0,
        expectedCount: 1,
      } satisfies SnapshotReferenceIssue)
    }
    const facts = [
      [['snapshotId'], row.snapshot_id, snapshot.snapshotId],
      [['schemaVersion'], row.schema_version, snapshot.schemaVersion],
      [['databaseName'], row.database_name, inputManifest.database],
      [['tableName'], row.table_name, inputManifest.tables.bars],
      [['datasetVersion'], row.dataset_version, snapshot.publicationSchemaVersion],
      [['source'], row.source, snapshot.source],
      [['sourceFeed'], row.source_feed, snapshot.sourceFeed],
      [['adjustment'], row.adjustment, snapshot.adjustment],
      [['contentHash'], row.content_hash, snapshot.contentHash],
      [['rowCount'], row.row_count, snapshot.rowCount],
      [['firstSession'], row.first_session, snapshot.firstSession],
      [['lastSession'], row.last_session, snapshot.lastSession],
    ] as const
    for (const [path, observed, expected] of facts) {
      if (observed !== expected) return yield* mismatch(path, observed, expected)
    }
    const storedManifestHash = yield* manifestHash('stored-manifest', row.manifest)
    const inputManifestHash = yield* manifestHash('input-manifest', snapshot)
    if (storedManifestHash !== inputManifestHash) {
      return yield* mismatch(['manifestHash'], storedManifestHash, inputManifestHash)
    }
  })

const renderFact = (value: unknown): string => {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'undefined':
      return String(value)
    case 'symbol':
      return value.description === undefined ? 'symbol' : `symbol(${value.description})`
    case 'function':
      return 'function'
    case 'object':
      return Array.isArray(value) ? `array(length=${value.length})` : 'object'
  }
  return 'unknown'
}

export const renderSnapshotReferenceIssue = (issue: SnapshotReferenceIssue): string => {
  switch (issue._tag) {
    case 'SnapshotReferenceCardinalityMismatch':
      return `snapshot ${issue.snapshotId} has ${issue.observedCount} references, expected ${issue.expectedCount}`
    case 'SnapshotReferenceMismatch':
      return `snapshot reference mismatch at ${issue.path.join('.')}: observed ${renderFact(issue.observed)}, expected ${renderFact(issue.expected)}`
    case 'SnapshotReferenceCanonicalizationFailed':
      return `${issue.subject} canonicalization failed: ${renderCanonicalJsonFailure(issue.cause)}`
  }
}

export const ensureSnapshotReferenceResult = (
  sql: PgClient.PgClient,
  inputManifest: InputManifest,
): Effect.Effect<Result.Result<void, SnapshotReferenceIssue>, SqlError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const snapshot = inputManifest.finalizedSnapshot
    yield* sql`
      INSERT INTO snapshot_references (
        snapshot_id,
        schema_version,
        database_name,
        table_name,
        dataset_version,
        source,
        source_feed,
        adjustment,
        content_hash,
        row_count,
        first_session,
        last_session,
        manifest
      ) VALUES (
        ${snapshot.snapshotId},
        ${snapshot.schemaVersion},
        ${inputManifest.database},
        ${inputManifest.tables.bars},
        ${snapshot.publicationSchemaVersion},
        ${snapshot.source},
        ${snapshot.sourceFeed},
        ${snapshot.adjustment},
        ${snapshot.contentHash},
        ${snapshot.rowCount},
        ${snapshot.firstSession},
        ${snapshot.lastSession},
        ${sql.json(snapshot)}
      )
      ON CONFLICT (snapshot_id) DO NOTHING
    `
    const rows = yield* sql<Record<string, unknown>>`
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
      WHERE snapshot_id = ${snapshot.snapshotId}
    `.pipe(Effect.flatMap(decodeSnapshotReferenceRows))
    return validateSnapshotReference(inputManifest, rows)
  })

export const ensureSnapshotReference = (
  sql: PgClient.PgClient,
  inputManifest: InputManifest,
): Effect.Effect<boolean, SqlError | Schema.SchemaError> =>
  ensureSnapshotReferenceResult(sql, inputManifest).pipe(Effect.map(Result.isSuccess))
