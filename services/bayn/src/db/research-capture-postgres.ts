import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import {
  ResearchCaptureFailure,
  ResearchCaptureIdSchema,
  decodeResearchCaptureChunk,
  decodeResearchCaptureSeal,
  maximumResearchCaptureChunkBytes,
  maximumResearchCaptureSealBytes,
  type ResearchCaptureBytes,
} from '../research-capture/capture'
import type { ResearchCaptureStore } from '../research-capture/recorder'
import { sha256 } from '../hash'
import { NonNegativeIntegerSchema, Sha256Schema, StrictNonEmptyStringSchema, strictParseOptions } from '../schemas'

const Rows = Schema.Array(Schema.Struct({ content_hash: Sha256Schema, payload: StrictNonEmptyStringSchema })).check(
  Schema.isMaxLength(1),
)
const decodeRows = Schema.decodeUnknownEffect(Rows, strictParseOptions)
const FrontierRow = Schema.Struct({
  ordinal: NonNegativeIntegerSchema,
  sequence: NonNegativeIntegerSchema,
  content_hash: Sha256Schema,
})
const FrontierRows = Schema.Array(FrontierRow).check(Schema.isMaxLength(1))
const AppendRows = Schema.Array(
  Schema.Union([
    Schema.Struct({
      inserted: Schema.Literal(true),
      content_hash: Schema.Null,
      payload: Schema.Null,
      frontier: Schema.NullOr(FrontierRow),
    }),
    Schema.Struct({
      inserted: Schema.Literal(false),
      content_hash: Sha256Schema,
      payload: StrictNonEmptyStringSchema,
      frontier: Schema.Null,
    }),
  ]),
).check(Schema.isMaxLength(1))
const frontier = (sql: PgClient.PgClient, captureId: string) =>
  sql`
  SELECT chunk_ordinal::double precision AS ordinal, content_hash,
    (payload::jsonb->'receipts'->-1->>'sequence')::double precision AS sequence
  FROM research_capture_chunks WHERE capture_id = ${captureId} ORDER BY chunk_ordinal DESC LIMIT 1
`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FrontierRows, strictParseOptions)),
    Effect.map((rows) => rows[0]),
  )
const failure = (message: string, cause?: unknown) => new ResearchCaptureFailure({ message, cause })
const run = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, ResearchCaptureFailure> =>
  effect.pipe(Effect.mapError((cause) => failure('Research capture persistence failed', cause)))

const verifyExisting = (rows: typeof Rows.Type, expected: ResearchCaptureBytes) =>
  Effect.gen(function* () {
    const row = rows[0]
    if (row === undefined || row.content_hash !== expected.contentHash || row.payload !== expected.payload)
      return yield* failure('Research capture identity conflicts with different exact bytes')
  })

export const readResearchCapturePostgresChunk = (
  sql: PgClient.PgClient,
  captureId: string,
  ordinal: number,
  maximumBytes: number,
): Effect.Effect<ResearchCaptureBytes, ResearchCaptureFailure> =>
  run(
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(ResearchCaptureIdSchema, strictParseOptions)(captureId)
      yield* Schema.decodeUnknownEffect(NonNegativeIntegerSchema, strictParseOptions)(ordinal)
      const budget = yield* Schema.decodeUnknownEffect(NonNegativeIntegerSchema, strictParseOptions)(maximumBytes)
      const limit = Math.min(budget, maximumResearchCaptureChunkBytes)
      const rows = yield* sql`
    SELECT content_hash, payload FROM research_capture_chunks
    WHERE capture_id = ${captureId} AND chunk_ordinal = ${ordinal}
      AND octet_length(convert_to(payload, 'UTF8')) <= ${limit}
  `.pipe(Effect.flatMap(decodeRows))
      const row = rows[0]
      if (row === undefined) return yield* failure('Capture chunk is missing or exceeds its SQL read limit')
      const bytes = { contentHash: row.content_hash, payload: row.payload }
      yield* Effect.fromResult(decodeResearchCaptureChunk(bytes))
      return bytes
    }),
  )

export const readResearchCapturePostgresSeal = (
  sql: PgClient.PgClient,
  captureId: string,
  maximumBytes: number,
): Effect.Effect<ResearchCaptureBytes, ResearchCaptureFailure> =>
  run(
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(ResearchCaptureIdSchema, strictParseOptions)(captureId)
      const budget = yield* Schema.decodeUnknownEffect(NonNegativeIntegerSchema, strictParseOptions)(maximumBytes)
      const limit = Math.min(budget, maximumResearchCaptureSealBytes)
      const rows = yield* sql`
    SELECT content_hash, payload FROM research_capture_seals
    WHERE capture_id = ${captureId}
      AND octet_length(convert_to(payload, 'UTF8')) <= ${limit}
  `.pipe(Effect.flatMap(decodeRows))
      const row = rows[0]
      if (row === undefined) return yield* failure('Capture seal is missing or exceeds its SQL read limit')
      const bytes = { contentHash: row.content_hash, payload: row.payload }
      yield* Effect.fromResult(decodeResearchCaptureSeal(bytes))
      return bytes
    }),
  )

export const makeResearchCapturePostgresStore = (sql: PgClient.PgClient): ResearchCaptureStore => ({
  append: (bytes) =>
    run(
      Effect.gen(function* () {
        const chunk = yield* Effect.fromResult(decodeResearchCaptureChunk(bytes))
        const chunkId = sha256(JSON.stringify(['bayn.research-capture-chunk.v1', chunk.captureId, chunk.chunkOrdinal]))
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${chunk.captureId}, 0))`
            // Keep this statement after the lock await: its snapshot must include the preceding writer's commit.
            const rows = yield* sql`
              WITH candidate AS MATERIALIZED (
                SELECT ${chunkId}::text AS chunk_id, ${chunk.captureId}::text AS capture_id,
                  ${chunk.chunkOrdinal}::bigint AS chunk_ordinal, ${bytes.contentHash}::text AS content_hash,
                  ${bytes.payload}::text AS payload, ${chunk.previousContentHash}::text AS previous_hash
              ), prior AS MATERIALIZED (
                SELECT stored.content_hash, stored.payload
                FROM research_capture_chunks stored CROSS JOIN candidate
                WHERE stored.capture_id = candidate.capture_id AND stored.chunk_ordinal = candidate.chunk_ordinal
              ), latest AS MATERIALIZED (
                SELECT stored.chunk_ordinal, stored.content_hash, stored.payload
                FROM research_capture_chunks stored CROSS JOIN candidate
                WHERE stored.capture_id = candidate.capture_id
                ORDER BY stored.chunk_ordinal DESC LIMIT 1
              ), inserted AS (
                INSERT INTO research_capture_chunks (chunk_id, capture_id, chunk_ordinal, content_hash, payload)
                SELECT chunk_id, capture_id, chunk_ordinal, content_hash, payload FROM candidate
                WHERE NOT EXISTS (SELECT 1 FROM prior)
                  AND chunk_ordinal = COALESCE((SELECT chunk_ordinal + 1 FROM latest), 0)
                  AND convert_to(previous_hash, 'UTF8') IS NOT DISTINCT FROM
                    (SELECT convert_to(content_hash, 'UTF8') FROM latest)
                RETURNING true AS inserted
              )
              SELECT inserted, NULL::text AS content_hash, NULL::text AS payload,
                (SELECT jsonb_build_object(
                  'ordinal', chunk_ordinal::double precision,
                  'sequence', (payload::jsonb->'receipts'->-1->>'sequence')::double precision,
                  'content_hash', content_hash
                ) FROM latest) AS frontier
              FROM inserted
              UNION ALL
              SELECT false AS inserted, content_hash, payload, NULL::jsonb AS frontier FROM prior
            `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(AppendRows, strictParseOptions)))
            const outcome = rows[0]
            if (outcome === undefined)
              return yield* failure('Research capture chunk does not extend its exact committed prefix')
            if (!outcome.inserted) yield* verifyExisting([outcome], bytes)
          }),
        )
      }),
    ),
  seal: (bytes) =>
    run(
      Effect.gen(function* () {
        const seal = yield* Effect.fromResult(decodeResearchCaptureSeal(bytes))
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${seal.captureId}, 0))`
            const prior = yield* sql`
              SELECT content_hash, payload FROM research_capture_seals WHERE capture_id = ${seal.captureId}
            `.pipe(Effect.flatMap(decodeRows))
            if (prior.length !== 0) return yield* verifyExisting(prior, bytes)
            const last = yield* frontier(sql, seal.captureId)
            if (
              seal.persistedChunks !== (last === undefined ? 0 : last.ordinal + 1) ||
              seal.persistedReceipts !== (last?.sequence ?? 0) ||
              seal.lastContentHash !== (last?.content_hash ?? null) ||
              seal.observedReceipts < seal.persistedReceipts ||
              (seal.invalidations.length === 0 && seal.observedReceipts !== seal.persistedReceipts)
            )
              return yield* failure('Research capture seal omits or changes the committed tail')
            yield* sql`INSERT INTO research_capture_seals (capture_id, content_hash, payload)
              VALUES (${seal.captureId}, ${bytes.contentHash}, ${bytes.payload})`
          }),
        )
      }),
    ),
})
