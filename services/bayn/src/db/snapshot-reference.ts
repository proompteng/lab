import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { strictParseOptions } from '../schemas'
import type { InputManifest } from '../types'

const SnapshotReferenceMatchSchema = Schema.Tuple([
  Schema.Struct({
    matches: Schema.Boolean,
  }),
])

const decodeSnapshotReferenceMatch = Schema.decodeUnknownEffect(SnapshotReferenceMatchSchema, strictParseOptions)

export const ensureSnapshotReference = (
  sql: PgClient.PgClient,
  inputManifest: InputManifest,
): Effect.Effect<boolean, unknown> =>
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
    const [match] = yield* sql<Record<string, unknown>>`
      SELECT count(*) = 1 AS matches
      FROM snapshot_references
      WHERE snapshot_id = ${snapshot.snapshotId}
        AND schema_version = ${snapshot.schemaVersion}
        AND database_name = ${inputManifest.database}
        AND table_name = ${inputManifest.tables.bars}
        AND dataset_version = ${snapshot.publicationSchemaVersion}
        AND source = ${snapshot.source}
        AND source_feed = ${snapshot.sourceFeed}
        AND adjustment = ${snapshot.adjustment}
        AND content_hash = ${snapshot.contentHash}
        AND row_count = ${snapshot.rowCount}
        AND first_session = ${snapshot.firstSession}
        AND last_session = ${snapshot.lastSession}
        AND manifest = ${sql.json(snapshot)}
    `.pipe(Effect.flatMap(decodeSnapshotReferenceMatch))
    return match.matches
  })
