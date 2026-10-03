import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Redacted, Result } from 'effect'

import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'
import { makeResearchCapturePostgresStore } from './research-capture-postgres'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { sha256 } from '../hash'
import {
  encodeResearchCapture,
  verifyResearchCapture,
  type ResearchCaptureChunk,
  type ResearchCaptureSeal,
} from '../research-capture/capture'
import { captureEvent, marketEvent } from '../research-capture/capture.test-support'

const postgresTest = baynTestPostgresUrl === undefined ? test.skip : test
const fixture = Effect.gen(function* () {
  yield* postgresMigrations
  const sql = yield* PgClient.PgClient
  const store = makeResearchCapturePostgresStore(sql)
  const chunk: ResearchCaptureChunk = {
    schemaVersion: 'bayn.research-capture-chunk.v1',
    captureId: randomUUID(),
    sourceRevision: 'a'.repeat(40),
    chunkOrdinal: 0,
    previousContentHash: null,
    receipts: [captureEvent('STARTED'), marketEvent, captureEvent('STOPPED')].map((event, index) => ({
      sequence: index + 1,
      observedAtMs: 100,
      event,
    })),
  }
  const bytes = encodeResearchCapture(chunk)
  const seal: ResearchCaptureSeal = {
    schemaVersion: 'bayn.research-capture-seal.v1',
    captureId: chunk.captureId,
    sourceRevision: chunk.sourceRevision,
    closedAtMs: 100,
    observedReceipts: 3,
    persistedReceipts: 3,
    persistedChunks: 1,
    lastContentHash: bytes.contentHash,
    invalidations: [],
  }
  return { sql, store, chunk, bytes, seal }
})
const run = <A, E>(program: Effect.Effect<A, E, Effect.Services<typeof fixture>>) => {
  if (baynTestPostgresUrl === undefined) throw new Error('Missing isolated capture test database')
  const url = new URL(baynTestPostgresUrl)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_test'))
    throw new Error('Capture tests require an isolated local _test database')
  return Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(
        PostgresClientLive({
          operationTimeoutMs: 30_000,
          postgres: { url: Redacted.make(baynTestPostgresUrl), tls: false, caPath: '/unused' },
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  )
}

postgresTest('exact-byte retries and concurrent lost-ack recovery are idempotent; divergent bytes conflict', () =>
  run(
    Effect.gen(function* () {
      const { sql, store, chunk, bytes, seal } = yield* fixture
      yield* Effect.all([store.append(bytes), store.append(bytes)], { concurrency: 2 })
      expect(
        yield* sql`SELECT content_hash, payload FROM research_capture_chunks WHERE capture_id = ${chunk.captureId}`,
      ).toEqual([{ content_hash: bytes.contentHash, payload: bytes.payload }])
      const differentEncoding = { payload: `${bytes.payload}\n`, contentHash: sha256(`${bytes.payload}\n`) }
      expect(Exit.isFailure(yield* Effect.exit(store.append(differentEncoding)))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(store.append({ ...bytes, contentHash: 'f'.repeat(64) })))).toBe(true)
      yield* store.seal(encodeResearchCapture(seal))
      yield* store.seal(encodeResearchCapture(seal))
      yield* store.append(bytes)
      expect(Exit.isFailure(yield* Effect.exit(store.seal(encodeResearchCapture({ ...seal, closedAtMs: 101 }))))).toBe(
        true,
      )
      expect(Result.getOrThrow(verifyResearchCapture([bytes], encodeResearchCapture(seal))).complete).toBe(true)
    }),
  ),
)

postgresTest('committed chunk frontier rejects gaps, wrong hashes, omitted tails and post-seal appends', () =>
  run(
    Effect.gen(function* () {
      const { store, chunk, bytes, seal } = yield* fixture
      expect(
        Exit.isFailure(yield* Effect.exit(store.append(encodeResearchCapture({ ...chunk, chunkOrdinal: 1 })))),
      ).toBe(true)
      yield* store.append(bytes)
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.seal(
              encodeResearchCapture({ ...seal, persistedReceipts: 0, persistedChunks: 0, lastContentHash: null }),
            ),
          ),
        ),
      ).toBe(true)
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.append(encodeResearchCapture({ ...chunk, chunkOrdinal: 1, previousContentHash: 'b'.repeat(64) })),
          ),
        ),
      ).toBe(true)
      yield* store.seal(encodeResearchCapture(seal))
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            store.append(encodeResearchCapture({ ...chunk, chunkOrdinal: 1, previousContentHash: bytes.contentHash })),
          ),
        ),
      ).toBe(true)
    }),
  ),
)

postgresTest('native append-only constraints reject rewrites, deletes, truncation and mismatched row bytes', () =>
  run(
    Effect.gen(function* () {
      const { sql, store, chunk, bytes, seal } = yield* fixture
      yield* store.append(bytes)
      yield* store.seal(encodeResearchCapture(seal))
      for (const mutation of [
        sql`UPDATE research_capture_chunks SET payload = payload WHERE capture_id = ${chunk.captureId}`,
        sql`DELETE FROM research_capture_chunks WHERE capture_id = ${chunk.captureId}`,
        sql`TRUNCATE research_capture_chunks`,
        sql`UPDATE research_capture_seals SET payload = payload WHERE capture_id = ${chunk.captureId}`,
        sql`DELETE FROM research_capture_seals WHERE capture_id = ${chunk.captureId}`,
        sql`TRUNCATE research_capture_seals`,
        sql`INSERT INTO research_capture_chunks (chunk_id, capture_id, chunk_ordinal, content_hash, payload)
      VALUES (${'f'.repeat(64)}, ${randomUUID()}, 0, ${'0'.repeat(64)}, ${bytes.payload})`,
      ])
        expect(Exit.isFailure(yield* Effect.exit(mutation))).toBe(true)
      expect(
        yield* sql`SELECT content_hash, payload FROM research_capture_chunks WHERE capture_id = ${chunk.captureId}`,
      ).toEqual([{ content_hash: bytes.contentHash, payload: bytes.payload }])
    }),
  ),
)
