import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Redacted, Result, Schema, type Scope } from 'effect'

import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'
import {
  makeResearchCapturePostgresStore,
  readResearchCapturePostgresChunk,
  readResearchCapturePostgresSeal,
} from './research-capture-postgres'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { sha256 } from '../hash'
import {
  CaptureInvalidation,
  CaptureQualification,
  captureKafkaTransport,
  ResearchCaptureFailure,
  encodeResearchCapture,
  maximumResearchCaptureChunkBytes,
  maximumResearchCaptureSealBytes,
  verifyResearchCapture,
  type ResearchCaptureChunk,
  type ResearchCaptureSeal,
} from '../research-capture/capture'
import {
  captureEvent,
  fullCaptureBufferEvents,
  marketEvent,
  recoverCaptureFromStoredObjects,
} from '../research-capture/capture.test-support'
import { researchCaptureObjectKey, type ResearchCaptureObject } from '../research-capture/export'
import { makeResearchCaptureRecorder } from '../research-capture/recorder'
import { sessionConfig } from '../research-capture/session.test-support'

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
    qualification: CaptureQualification.Unqualified,
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
const run = <A, E>(program: Effect.Effect<A, E, Effect.Services<typeof fixture> | Scope.Scope>) => {
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

postgresTest('a session claim commits before objects and a fresh attempt cannot reuse the fixed capture identity', () =>
  run(
    Effect.gen(function* () {
      const { sql, store, chunk } = yield* fixture
      const { captureId: _captureId, calendar: _calendar, sessionDate: _sessionDate, ...session } = sessionConfig
      const options = {
        captureId: chunk.captureId,
        sourceRevision: chunk.sourceRevision,
        maximumQueuedReceipts: 1024,
        maximumQueuedBytes: 4 * 1024 * 1024,
        maximumReceiptBytes: 64 * 1024,
        flushIntervalMs: 50,
        writeTimeoutMs: 1000,
        maximumObjectBytes: session.maximumObjectBytes,
        maximumSqlBytes: session.maximumSqlBytes,
        session,
      }
      let objects = 0
      const first = yield* makeResearchCaptureRecorder(store, options, {
        putVerified: () =>
          Effect.gen(function* () {
            const claim = yield* readResearchCapturePostgresChunk(sql, chunk.captureId, 0, 64 * 1024)
            expect(claim.payload).toContain('session-attempt')
            objects++
          }),
      })
      const claimed = yield* readResearchCapturePostgresChunk(sql, chunk.captureId, 0, 64 * 1024)
      expect(objects).toBe(3)
      const second = yield* makeResearchCaptureRecorder(store, options, {
        putVerified: () => Effect.die('a reused claim must not write objects'),
      })
      expect((yield* second.status).invalidations).toContain(CaptureInvalidation.Persistence)
      expect(yield* second.finish).toBeUndefined()
      expect(yield* readResearchCapturePostgresChunk(sql, chunk.captureId, 0, 64 * 1024)).toEqual(claimed)
      expect((yield* first.finish)?.qualification).toBe(CaptureQualification.Unqualified)
    }),
  ),
)

postgresTest('SQL capture reads bound UTF8 payloads before returning and preserve exact hashes and text', () =>
  run(
    Effect.gen(function* () {
      const { sql, store, chunk, seal } = yield* fixture
      const unicodeChunk: ResearchCaptureChunk = {
        ...chunk,
        receipts: chunk.receipts.map((receipt, index) =>
          index === 0 ? { ...receipt, event: { ...captureEvent('STARTED'), reason: 'é'.repeat(1024) } } : receipt,
        ),
      }
      const bytes = encodeResearchCapture(unicodeChunk)
      const byteLength = Buffer.byteLength(bytes.payload, 'utf8')
      expect(byteLength).toBeGreaterThan(bytes.payload.length)
      yield* store.append(bytes)
      for (const limit of [0, bytes.payload.length, byteLength - 1])
        expect(
          Exit.isFailure(yield* Effect.exit(readResearchCapturePostgresChunk(sql, chunk.captureId, 0, limit))),
        ).toBe(true)
      expect(yield* readResearchCapturePostgresChunk(sql, chunk.captureId, 0, byteLength)).toEqual(bytes)
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            readResearchCapturePostgresChunk(sql, chunk.captureId, 1, maximumResearchCaptureChunkBytes),
          ),
        ),
      ).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(readResearchCapturePostgresChunk(sql, chunk.captureId, 0, -1)))).toBe(
        true,
      )
      const sealBytes = encodeResearchCapture({ ...seal, lastContentHash: bytes.contentHash })
      yield* store.seal(sealBytes)
      const sealLength = Buffer.byteLength(sealBytes.payload, 'utf8')
      expect(
        Exit.isFailure(yield* Effect.exit(readResearchCapturePostgresSeal(sql, chunk.captureId, sealLength - 1))),
      ).toBe(true)
      expect(yield* readResearchCapturePostgresSeal(sql, chunk.captureId, sealLength)).toEqual(sealBytes)
      expect(
        Exit.isFailure(
          yield* Effect.exit(readResearchCapturePostgresSeal(sql, randomUUID(), maximumResearchCaptureSealBytes)),
        ),
      ).toBe(true)
    }),
  ),
)

postgresTest('measures the actual text-chunk schema using bounded synthetic receipt batches', () =>
  run(
    Effect.gen(function* () {
      const { sql, store, chunk: identity } = yield* fixture
      const size = sql`SELECT pg_total_relation_size('research_capture_chunks')::double precision AS bytes`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ bytes: Schema.Number })]))),
        Effect.map(([row]) => row.bytes),
      )
      const before = yield* size
      let previousContentHash: string | null = null
      let encodedBytes = 0
      const chunkCount = 8
      const receiptsPerChunk = 256
      for (let ordinal = 0; ordinal < chunkCount; ordinal++) {
        const receipts = Array.from({ length: receiptsPerChunk }, (_, index) => {
          const sequence = ordinal * receiptsPerChunk + index + 1
          return {
            sequence,
            observedAtMs: 100 + sequence,
            event:
              sequence === 1
                ? captureEvent('STARTED')
                : sequence === chunkCount * receiptsPerChunk
                  ? captureEvent('STOPPED')
                  : {
                      ...marketEvent,
                      consumerSequence: sequence - 1,
                      projectionSequence: sequence - 1,
                      offset: String(sequence - 2),
                      rawValueSha256: sha256(randomUUID()),
                    },
          }
        })
        const bytes = encodeResearchCapture({ ...identity, chunkOrdinal: ordinal, previousContentHash, receipts })
        yield* store.append(bytes)
        previousContentHash = bytes.contentHash
        encodedBytes += Buffer.byteLength(bytes.payload, 'utf8')
      }
      const after = yield* size
      expect(after).toBeGreaterThan(before)
      yield* Effect.logInfo('Synthetic original-receipt storage measurement', {
        chunkCount,
        receiptsPerChunk,
        encodedBytes,
        allocatedBytes: after - before,
        allocatedBytesPerReceipt: (after - before) / (chunkCount * receiptsPerChunk),
        includes: 'heap, indexes, TOAST allocation delta; synthetic fixture only',
      })
    }),
  ),
)

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
      const verified = Result.getOrThrow(verifyResearchCapture([bytes], encodeResearchCapture(seal)))
      expect(verified.structurallyClosed).toBe(true)
      expect(verified.complete).toBe(false)
    }),
  ),
)

postgresTest('durable SQL seal recovers raw objects after process state and seal acknowledgement are lost', () =>
  run(
    Effect.gen(function* () {
      const { sql, store, chunk } = yield* fixture
      const bucket = new Map<string, ResearchCaptureObject>()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const recorder = yield* makeResearchCaptureRecorder(
            {
              ...store,
              seal: (bytes) =>
                store
                  .seal(bytes)
                  .pipe(
                    Effect.andThen(
                      Effect.fail(new ResearchCaptureFailure({ message: 'Seal committed; acknowledgement lost' })),
                    ),
                  ),
            },
            {
              captureId: chunk.captureId,
              sourceRevision: chunk.sourceRevision,
              maximumQueuedReceipts: 16,
              maximumQueuedBytes: 256 * 1024,
              maximumReceiptBytes: 4096,
              flushIntervalMs: 1000,
              writeTimeoutMs: 1000,
            },
            {
              putVerified: (object) =>
                Effect.sync(() => {
                  bucket.set(researchCaptureObjectKey(object.contentHash), {
                    ...object,
                    payload: Buffer.from(object.payload),
                  })
                }),
            },
          )
          recorder.record(captureEvent('STARTED'), 100)
          recorder.record({ ...marketEvent, originalTransport: captureKafkaTransport(NaN) }, 100, Buffer.from('é'))
          recorder.record(captureEvent('STOPPED'), 100)
        }),
      )
      const capturedChunk = yield* readResearchCapturePostgresChunk(
        sql,
        chunk.captureId,
        0,
        maximumResearchCaptureChunkBytes,
      )
      const seal = yield* readResearchCapturePostgresSeal(sql, chunk.captureId, maximumResearchCaptureSealBytes)
      const reads: string[] = []
      const recovered = Result.getOrThrow(
        recoverCaptureFromStoredObjects([capturedChunk], seal, (key) => {
          reads.push(key)
          return bucket.get(key)
        }),
      )
      expect(reads).toHaveLength(4)
      expect(recovered.seal.exportRoot?.exportedChunks).toBe(1)
      expect(recovered.exportVerified).toBe(true)
      expect(recovered.structurallyClosed).toBe(true)
      expect(recovered.complete).toBe(false)
      expect(recovered.seal.qualification).toBe(CaptureQualification.Unqualified)
    }),
  ),
)

postgresTest('committed metadata seal remains unqualified after its acknowledgement is lost', () =>
  run(
    Effect.gen(function* () {
      const { sql, store, chunk } = yield* fixture
      const recorder = yield* makeResearchCaptureRecorder(
        {
          ...store,
          seal: (bytes) =>
            store
              .seal(bytes)
              .pipe(
                Effect.andThen(
                  Effect.fail(new ResearchCaptureFailure({ message: 'seal committed; acknowledgement lost' })),
                ),
              ),
        },
        {
          captureId: chunk.captureId,
          sourceRevision: chunk.sourceRevision,
          maximumQueuedReceipts: 16,
          maximumQueuedBytes: 16_384,
          maximumReceiptBytes: 4096,
          flushIntervalMs: 1000,
          writeTimeoutMs: 1000,
        },
      )
      recorder.record(captureEvent('STARTED'), 100)
      recorder.record(captureEvent('STOPPED'), 100)
      const closed = yield* recorder.finish
      expect(closed?.invalidations).toContain(CaptureInvalidation.Persistence)
      const decode = Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ content_hash: Schema.String, payload: Schema.String })),
      )
      const chunks =
        yield* sql`SELECT content_hash, payload FROM research_capture_chunks WHERE capture_id = ${chunk.captureId} ORDER BY chunk_ordinal`.pipe(
          Effect.flatMap(decode),
        )
      const seals =
        yield* sql`SELECT content_hash, payload FROM research_capture_seals WHERE capture_id = ${chunk.captureId}`.pipe(
          Effect.flatMap(decode),
        )
      const bytes = (row: (typeof chunks)[number]) => ({ contentHash: row.content_hash, payload: row.payload })
      const stored = seals[0]
      expect(stored).toBeDefined()
      const verified = Result.getOrThrow(
        verifyResearchCapture(chunks.map(bytes), stored === undefined ? undefined : bytes(stored)),
      )
      expect(verified.seal.invalidations).toEqual([])
      expect(verified.seal.qualification).toBe(CaptureQualification.Unqualified)
      expect(verified.structurallyClosed).toBe(true)
      expect(verified.complete).toBe(false)
    }),
  ),
)

postgresTest('full UTF8 queue splits into database-sized chunks without oversized SQL attempts', () =>
  run(
    Effect.gen(function* () {
      const { sql, store, chunk } = yield* fixture
      const attemptedSizes: number[] = []
      const recorder = yield* makeResearchCaptureRecorder(
        {
          ...store,
          append: (bytes) =>
            Effect.gen(function* () {
              const size = Buffer.byteLength(bytes.payload, 'utf8')
              attemptedSizes.push(size)
              if (size > maximumResearchCaptureChunkBytes)
                return yield* new ResearchCaptureFailure({ message: 'oversized SQL attempt' })
              yield* store.append(bytes)
            }),
        },
        {
          captureId: chunk.captureId,
          sourceRevision: chunk.sourceRevision,
          maximumQueuedReceipts: 64,
          maximumQueuedBytes: maximumResearchCaptureChunkBytes,
          maximumReceiptBytes: 64 * 1024,
          flushIntervalMs: 1000,
          writeTimeoutMs: 1000,
        },
      )
      for (const event of fullCaptureBufferEvents()) recorder.record(event, 100)
      const closed = yield* recorder.finish
      expect(closed?.invalidations).toEqual([])
      expect(closed?.persistedReceipts).toBe(64)
      expect(attemptedSizes).toHaveLength(2)
      expect(attemptedSizes.every((size) => size <= maximumResearchCaptureChunkBytes)).toBe(true)
      expect(
        yield* sql`SELECT count(*)::integer AS count FROM research_capture_chunks WHERE capture_id = ${chunk.captureId}`,
      ).toEqual([{ count: 2 }])
    }),
  ),
)

postgresTest('seal rows reject missing or fabricated qualification claims', () =>
  run(
    Effect.gen(function* () {
      const { sql, seal } = yield* fixture
      for (const qualification of [undefined, 'QUALIFIED']) {
        const captureId = randomUUID()
        const payload = JSON.stringify({ ...seal, captureId, qualification })
        expect(
          Exit.isFailure(
            yield* Effect.exit(sql`INSERT INTO research_capture_seals (capture_id, content_hash, payload)
        VALUES (${captureId}, ${sha256(payload)}, ${payload})`),
          ),
        ).toBe(true)
      }
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
