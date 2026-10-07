import { expect, test } from 'bun:test'
import { Cause, Deferred, Effect, Exit, Fiber, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import fc from 'fast-check'

import { provideTestLayer } from '../effect-test-support'
import { sha256 } from '../hash'
import {
  CaptureDisposition,
  CaptureInvalidation,
  CaptureQualification,
  captureKafkaTransport,
  ResearchCaptureFailure,
  encodeResearchCapture,
  decodeResearchCaptureSeal,
  type ResearchCaptureBytes,
  type ResearchCaptureChunk,
  type ResearchCaptureSeal,
} from './capture'
import {
  captureEvent,
  marketEvent as metadataMarketEvent,
  recoverCaptureFromStoredObjects,
} from './capture.test-support'
import {
  buildResearchCaptureExportChunk,
  deriveResearchCaptureExportManifest,
  persistResearchCaptureExportChunk,
  ResearchCaptureByteIndexSchema,
  researchCaptureObject,
  researchCaptureObjectKey,
  researchCaptureExportEnvelopeReservation,
  researchCaptureExportEntryReservation,
  verifyResearchCaptureExport,
  type ResearchCaptureObject,
  type ResearchCaptureObjectStore,
} from './export'
import { makeResearchCaptureRecorder, type ResearchCaptureStore } from './recorder'

const marketEvent = { ...metadataMarketEvent, originalTransport: captureKafkaTransport(100) }

const options = {
  captureId: 'capture-raw',
  sourceRevision: 'a'.repeat(40),
  maximumQueuedReceipts: 32,
  maximumQueuedBytes: 256 * 1024,
  maximumReceiptBytes: 4096,
  flushIntervalMs: 10,
  writeTimeoutMs: 50,
}
const run = <A, E>(effect: Effect.Effect<A, E, import('effect').Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(provideTestLayer(TestClock.layer())))
const text = (object: ResearchCaptureObject): ResearchCaptureBytes => ({
  contentHash: object.contentHash,
  payload: Buffer.from(object.payload).toString('utf8'),
})
const memory = () => {
  const chunks: ResearchCaptureBytes[] = []
  const seals: ResearchCaptureBytes[] = []
  const objects: ResearchCaptureObject[] = []
  const store: ResearchCaptureStore = {
    append: (value) =>
      Effect.sync(() => {
        chunks.push(value)
      }),
    seal: (value) =>
      Effect.sync(() => {
        seals.push(value)
      }),
  }
  const objectStore: ResearchCaptureObjectStore = {
    putVerified: (object) =>
      Effect.sync(() => {
        objects.push({ ...object, payload: Buffer.from(object.payload) })
      }),
  }
  const verify = () => {
    const seal = seals[0]
    const manifest = objects.at(-1)
    if (seal === undefined || manifest === undefined) throw new Error('Expected finalized export')
    const exported = chunks.map((metadata, index) => {
      const raw = objects[index * 3]
      const rangeIndex = objects[index * 3 + 2]
      if (raw === undefined || rangeIndex === undefined) throw new Error('Expected exported chunk')
      return { metadata, index: text(rangeIndex), raw: raw.payload }
    })
    return verifyResearchCaptureExport(exported, seal, text(manifest))
  }
  return { chunks, seals, objects, store, objectStore, verify }
}

test('verifies raw and metadata concurrently before publishing their immutable index', () =>
  run(
    Effect.gen(function* () {
      const objects = {
        raw: researchCaptureObject('raw'),
        metadata: researchCaptureObject('metadata'),
        index: researchCaptureObject('index'),
      }
      const rawStarted = yield* Deferred.make<void>()
      const metadataStarted = yield* Deferred.make<void>()
      const releaseRaw = yield* Deferred.make<void>()
      const releaseMetadata = yield* Deferred.make<void>()
      const verified: string[] = []
      const store: ResearchCaptureObjectStore = {
        putVerified: (object) =>
          Effect.gen(function* () {
            if (object === objects.raw) {
              yield* Deferred.succeed(rawStarted, undefined)
              yield* Deferred.await(releaseRaw)
            } else if (object === objects.metadata) {
              yield* Deferred.succeed(metadataStarted, undefined)
              yield* Deferred.await(releaseMetadata)
            } else {
              expect(verified).toContain(objects.raw.contentHash)
              expect(verified).toContain(objects.metadata.contentHash)
            }
            verified.push(object.contentHash)
          }),
      }
      const fiber = yield* persistResearchCaptureExportChunk(store, objects).pipe(Effect.forkScoped)
      yield* Deferred.await(rawStarted)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(metadataStarted)).toBe(true)
      expect(verified).toEqual([])
      yield* Deferred.succeed(releaseRaw, undefined)
      yield* Effect.yieldNow
      expect(verified).not.toContain(objects.index.contentHash)
      yield* Deferred.succeed(releaseMetadata, undefined)
      expect(yield* Fiber.join(fiber)).toBe(objects.index.contentHash)
      expect(verified).toHaveLength(3)
    }),
  ))

test('a failed raw write interrupts the concurrent metadata write and withholds the index', () =>
  run(
    Effect.gen(function* () {
      const objects = {
        raw: researchCaptureObject('raw'),
        metadata: researchCaptureObject('metadata'),
        index: researchCaptureObject('index'),
      }
      const metadataStarted = yield* Deferred.make<void>()
      let metadataInterrupted = false
      let indexWritten = false
      const store: ResearchCaptureObjectStore = {
        putVerified: (object) =>
          object === objects.raw
            ? Deferred.await(metadataStarted).pipe(
                Effect.andThen(Effect.fail(new ResearchCaptureFailure({ message: 'raw write failed' }))),
              )
            : object === objects.metadata
              ? Deferred.succeed(metadataStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      metadataInterrupted = true
                    }),
                  ),
                )
              : Effect.sync(() => {
                  indexWritten = true
                }),
      }
      const result = yield* persistResearchCaptureExportChunk(store, objects).pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      expect(metadataInterrupted).toBe(true)
      expect(indexWritten).toBe(false)
    }),
  ))

test.each(['acknowledged', 'seal-ack-lost', 'manifest-ack-lost', 'interrupted-prefix', 'empty'] as const)(
  'process-loss recovery uses only durable SQL and content-addressed Gets (%s)',
  async (fault) => {
    const saved = memory()
    const bucket = new Map<string, ResearchCaptureObject>()
    let puts = 0
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(100)
        const recorder = yield* makeResearchCaptureRecorder(
          {
            ...saved.store,
            seal: (bytes) =>
              saved.store
                .seal(bytes)
                .pipe(
                  Effect.andThen(
                    fault === 'seal-ack-lost'
                      ? Effect.fail(new ResearchCaptureFailure({ message: 'Seal committed, acknowledgement lost' }))
                      : Effect.void,
                  ),
                ),
          },
          options,
          {
            putVerified: (object) =>
              Effect.gen(function* () {
                puts++
                bucket.set(researchCaptureObjectKey(object.contentHash), {
                  ...object,
                  payload: Buffer.from(object.payload),
                })
                if (fault === 'manifest-ack-lost' && puts === 5)
                  return yield* new ResearchCaptureFailure({ message: 'Manifest committed, acknowledgement lost' })
              }),
          },
        )
        if (fault === 'empty') return
        recorder.record(captureEvent('STARTED'), 100)
        recorder.record(marketEvent, 100, Buffer.from('é'))
        if (fault === 'interrupted-prefix') recorder.invalidate(CaptureInvalidation.Interrupted)
        else recorder.record(captureEvent('STOPPED'), 100)
      }),
    )
    const reads: string[] = []
    const recovered = recoverCaptureFromStoredObjects(saved.chunks, saved.seals[0], (key) => {
      reads.push(key)
      return bucket.get(key)
    })
    expect(saved.seals).toHaveLength(fault === 'manifest-ack-lost' ? 0 : 1)
    if (fault === 'manifest-ack-lost') {
      expect(bucket.size).toBe(5)
      expect(Result.isFailure(recovered)).toBe(true)
      expect(reads).toEqual([])
    } else {
      const result = Result.getOrThrow(recovered)
      expect(result.complete).toBe(false)
      expect(result.structurallyClosed).toBe(fault !== 'interrupted-prefix')
      expect(result.seal.qualification).toBe(CaptureQualification.Unqualified)
      expect(reads).toHaveLength(fault === 'empty' ? 1 : 4)
    }
  },
)

test.each(['manifest', 'index', 'metadata', 'raw', 'corrupt-raw'] as const)(
  'durable root cannot conceal a missing or corrupt %s object',
  (fault) =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(100)
        const saved = memory()
        yield* Effect.scoped(
          Effect.gen(function* () {
            const recorder = yield* makeResearchCaptureRecorder(saved.store, options, saved.objectStore)
            recorder.record(captureEvent('STARTED'), 100)
            recorder.record(marketEvent, 100, Buffer.from('é'))
            recorder.record(captureEvent('STOPPED'), 100)
          }),
        )
        const bucket = new Map(saved.objects.map((object) => [researchCaptureObjectKey(object.contentHash), object]))
        const position = { manifest: 4, index: 2, metadata: 1, raw: 0, 'corrupt-raw': 0 }[fault]
        const target = saved.objects[position]
        if (target === undefined) throw new Error('Expected persisted object')
        const key = researchCaptureObjectKey(target.contentHash)
        if (fault === 'corrupt-raw') bucket.set(key, { ...target, payload: Buffer.from('wrong') })
        else bucket.delete(key)
        expect(
          Result.isFailure(recoverCaptureFromStoredObjects(saved.chunks, saved.seals[0], (key) => bucket.get(key))),
        ).toBe(true)
      }),
    ),
)

test('metadata-only capture retains byte-identical legacy chunks and seals', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const recorder = yield* makeResearchCaptureRecorder(saved.store, options)
      recorder.record(captureEvent('STARTED'), 100)
      recorder.record(captureEvent('STOPPED'), 100)
      yield* recorder.finish
      const chunk = encodeResearchCapture({
        schemaVersion: 'bayn.research-capture-chunk.v1',
        captureId: options.captureId,
        sourceRevision: options.sourceRevision,
        chunkOrdinal: 0,
        previousContentHash: null,
        receipts: [captureEvent('STARTED'), captureEvent('STOPPED')].map((event, index) => ({
          sequence: index + 1,
          observedAtMs: 100,
          event,
        })),
      })
      const seal = encodeResearchCapture({
        schemaVersion: 'bayn.research-capture-seal.v1',
        qualification: CaptureQualification.Unqualified,
        captureId: options.captureId,
        sourceRevision: options.sourceRevision,
        closedAtMs: 100,
        observedReceipts: 2,
        persistedReceipts: 2,
        persistedChunks: 1,
        lastContentHash: chunk.contentHash,
        invalidations: [],
      })
      expect(saved.chunks).toEqual([chunk])
      expect(saved.seals).toEqual([seal])
      expect(recorder.rawValues).toBeUndefined()
      expect(Result.isFailure(deriveResearchCaptureExportManifest(seal))).toBe(true)
    }),
  ))

test('raw admission rejects an absent transport block without inferring payload time', () =>
  run(
    Effect.gen(function* () {
      const saved = memory()
      const recorder = yield* makeResearchCaptureRecorder(saved.store, options, saved.objectStore)
      recorder.record(metadataMarketEvent, 100, Buffer.from('é'))
      const seal = yield* recorder.finish
      expect(seal?.invalidations).toContain(CaptureInvalidation.InvalidEvent)
      expect(saved.chunks).toHaveLength(0)
    }),
  ))

test('absent and inconsistent durable roots cannot reconstruct an export manifest', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const recorder = yield* makeResearchCaptureRecorder(saved.store, options, saved.objectStore)
      recorder.record(captureEvent('STARTED'), 100)
      recorder.record(captureEvent('STOPPED'), 100)
      yield* recorder.finish
      const stored = saved.seals[0]
      if (stored === undefined) throw new Error('Expected seal')
      const decoded = Result.getOrThrow(decodeResearchCaptureSeal(stored))
      for (const exportRoot of [
        undefined,
        { schemaVersion: 'bayn.research-capture-export-root.v1', exportedChunks: 2, lastIndexHash: 'a'.repeat(64) },
        { schemaVersion: 'bayn.research-capture-export-root.v1', exportedChunks: 1, lastIndexHash: null },
        { schemaVersion: 'foreign-root.v1', exportedChunks: 1, lastIndexHash: 'a'.repeat(64) },
      ]) {
        const bytes = text(researchCaptureObject(JSON.stringify({ ...decoded, exportRoot })))
        expect(Result.isFailure(deriveResearchCaptureExportManifest(bytes))).toBe(true)
      }
    }),
  ))

test('raw capture owns exact malformed, ignored, empty and tombstone bytes while metadata remains unqualified', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const recorder = yield* makeResearchCaptureRecorder(saved.store, options, saved.objectStore)
      recorder.record(captureEvent('STARTED'), 100)
      const originals = [Buffer.from([0x80]), Buffer.from([0x81]), Buffer.alloc(0), null]
      for (const [index, raw] of originals.entries()) {
        recorder.record(
          {
            ...marketEvent,
            consumerSequence: index + 1,
            offset: String(index),
            rawValueSha256: raw === null ? null : sha256(raw),
            rawByteLength: raw?.byteLength ?? null,
            tombstone: raw === null,
            disposition: index === 1 ? CaptureDisposition.Ignored : CaptureDisposition.Rejected,
          },
          100,
          raw,
        )
        raw?.fill(0xff)
      }
      recorder.record(captureEvent('STOPPED'), 100)
      const before = yield* recorder.status
      expect(before.retainedPayloadBytes).toBeLessThanOrEqual(options.maximumQueuedBytes)
      const seal = yield* recorder.finish
      expect(yield* recorder.finish).toEqual(seal)
      expect(saved.seals).toHaveLength(1)
      expect(saved.objects).toHaveLength(5)
      expect(seal).toMatchObject({
        exportRoot: {
          schemaVersion: 'bayn.research-capture-export-root.v1',
          exportedChunks: 1,
          lastIndexHash: saved.objects[2]?.contentHash,
        },
      })
      expect(saved.objects[0]?.payload).toEqual(Buffer.from([0x80, 0x81]))
      const verified = Result.getOrThrow(saved.verify())
      expect(verified.structurallyClosed).toBe(true)
      expect(verified.exportVerified).toBe(true)
      expect(verified.complete).toBe(false)
      expect(verified.seal.qualification).toBe(CaptureQualification.Unqualified)
      expect((yield* recorder.status).exportManifestHash).toBe(saved.objects.at(-1)?.contentHash ?? null)
      expect((yield* recorder.status).retainedReceipts).toBe(0)
    }),
  ))

test.each(['missing', 'wrong-length', 'wrong-hash', 'tombstone-bytes'] as const)(
  'raw admission rejects %s before any raw export',
  (fault) =>
    run(
      Effect.gen(function* () {
        const saved = memory()
        const recorder = yield* makeResearchCaptureRecorder(saved.store, options, saved.objectStore)
        const raw = fault === 'missing' ? undefined : fault === 'wrong-length' ? Buffer.alloc(1) : Buffer.from('xx')
        recorder.record(
          fault === 'tombstone-bytes'
            ? { ...marketEvent, tombstone: true, rawByteLength: null, rawValueSha256: null }
            : marketEvent,
          100,
          raw,
        )
        const seal = yield* recorder.finish
        expect(seal?.invalidations).toContain(CaptureInvalidation.MissingRawIdentity)
        expect(saved.chunks).toHaveLength(0)
        expect(saved.objects).toHaveLength(2)
      }),
    ),
)

test('in-flight payload and receipt reservations cannot be reused by nonblocking admission', () =>
  run(
    Effect.gen(function* () {
      const saved = memory()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let blocked = false
      const recorder = yield* makeResearchCaptureRecorder(
        saved.store,
        { ...options, maximumQueuedReceipts: 1 },
        {
          putVerified: (object) =>
            Effect.gen(function* () {
              if (!blocked) {
                blocked = true
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }
              yield* saved.objectStore.putVerified(object)
            }),
        },
      )
      recorder.record(captureEvent('STARTED'), 100)
      const admitted = yield* recorder.status
      yield* TestClock.adjust(10)
      yield* Deferred.await(entered)
      expect((yield* recorder.status).retainedPayloadBytes).toBe(admitted.retainedPayloadBytes)
      expect(recorder.record(captureEvent('STOPPED'), 100)).toBeUndefined()
      expect((yield* recorder.status).invalidations).toContain(CaptureInvalidation.Overflow)
      yield* Deferred.succeed(release, undefined)
      const seal = yield* recorder.finish
      expect(seal?.persistedReceipts).toBe(1)
      expect(seal?.observedReceipts).toBe(2)
      expect((yield* recorder.status).retainedPayloadBytes).toBe(researchCaptureExportEnvelopeReservation)
    }),
  ))

test.each(['sql-append', 'object-ack', 'object-defect', 'object-throw', 'object-interrupt'] as const)(
  '%s failure never advances the durable raw frontier or changes the owner result',
  (fault) =>
    run(
      Effect.gen(function* () {
        const saved = memory()
        let attempts = 0
        const recorder = yield* makeResearchCaptureRecorder(
          {
            ...saved.store,
            append: (bytes) =>
              fault === 'sql-append'
                ? saved.store
                    .append(bytes)
                    .pipe(
                      Effect.andThen(Effect.fail(new ResearchCaptureFailure({ message: 'SQL acknowledgement lost' }))),
                    )
                : saved.store.append(bytes),
          },
          options,
          {
            putVerified: (object) => {
              attempts++
              if (attempts === 1 && fault === 'object-throw') throw new Error('sink defect')
              if (attempts === 1 && fault === 'object-defect') return Effect.die(new Error('sink defect'))
              if (attempts === 1 && fault === 'object-interrupt') return Effect.interrupt
              return saved.objectStore
                .putVerified(object)
                .pipe(
                  Effect.andThen(
                    attempts === 1 && fault === 'object-ack'
                      ? Effect.fail(new ResearchCaptureFailure({ message: 'object acknowledgement lost' }))
                      : Effect.void,
                  ),
                )
            },
          },
        )
        recorder.record(captureEvent('STARTED'), 100)
        recorder.record(captureEvent('STOPPED'), 100)
        const seal = yield* recorder.finish
        expect(seal?.persistedChunks).toBe(0)
        expect(seal?.persistedReceipts).toBe(0)
        expect(seal?.invalidations).toContain(CaptureInvalidation.Persistence)
        expect((yield* recorder.status).retainedReceipts).toBe(0)
        expect(attempts).toBe(fault === 'sql-append' ? 5 : 3)
        const durableManifest = JSON.parse(text(saved.objects.at(-1) ?? researchCaptureObject('{}')).payload)
        expect(durableManifest.lastIndexHash).toBeNull()
        expect(durableManifest.qualification).toBe(CaptureQualification.Unqualified)
        return 'owner result'
      }),
    ),
)

test('property: immutable byte ranges round-trip arbitrary binary payloads and detect mutation', () => {
  fc.assert(
    fc.property(fc.array(fc.option(fc.uint8Array({ maxLength: 64 }), { nil: null }), { maxLength: 24 }), (values) => {
      const entries = [
        { receipt: { sequence: 1, observedAtMs: 100, event: captureEvent('STARTED') } },
        ...values.map((rawValue, index) => ({
          rawValue,
          receipt: {
            sequence: index + 2,
            observedAtMs: 100,
            event: {
              ...marketEvent,
              consumerSequence: index + 1,
              offset: String(index),
              tombstone: rawValue === null,
              rawValueSha256: rawValue === null ? null : sha256(rawValue),
              rawByteLength: rawValue?.byteLength ?? null,
            },
          },
        })),
        { receipt: { sequence: values.length + 2, observedAtMs: 100, event: captureEvent('STOPPED') } },
      ]
      const chunk: ResearchCaptureChunk = {
        schemaVersion: 'bayn.research-capture-chunk.v1',
        captureId: options.captureId,
        sourceRevision: options.sourceRevision,
        chunkOrdinal: 0,
        previousContentHash: null,
        receipts: entries.map((entry) => entry.receipt),
      }
      const metadata = encodeResearchCapture(chunk)
      const objects = buildResearchCaptureExportChunk(chunk, metadata, entries, null)
      const seal: ResearchCaptureSeal = {
        schemaVersion: 'bayn.research-capture-seal.v1',
        qualification: CaptureQualification.Unqualified,
        captureId: options.captureId,
        sourceRevision: options.sourceRevision,
        closedAtMs: 100,
        observedReceipts: entries.length,
        persistedReceipts: entries.length,
        persistedChunks: 1,
        lastContentHash: metadata.contentHash,
        invalidations: [],
        exportRoot: {
          schemaVersion: 'bayn.research-capture-export-root.v1',
          exportedChunks: 1,
          lastIndexHash: objects.index.contentHash,
        },
      }
      const sealBytes = encodeResearchCapture(seal)
      const manifest = text(Result.getOrThrow(deriveResearchCaptureExportManifest(sealBytes)))
      const exported = [{ metadata, raw: objects.raw.payload, index: text(objects.index) }]
      expect(Result.getOrThrow(verifyResearchCaptureExport(exported, sealBytes, manifest)).complete).toBe(false)
      const rawLength = values.reduce((sum, value) => sum + (value?.byteLength ?? 0), 0)
      const reservation =
        researchCaptureExportEnvelopeReservation +
        entries.reduce(
          (sum, entry) =>
            sum +
            researchCaptureExportEntryReservation(
              Buffer.byteLength(JSON.stringify(entry.receipt)),
              'rawValue' in entry ? (entry.rawValue?.byteLength ?? 0) : 0,
            ),
          0,
        )
      const allocatedWireBytes =
        rawLength +
        2 * (objects.raw.payload.byteLength + objects.metadata.payload.byteLength + objects.index.payload.byteLength) +
        Buffer.byteLength(metadata.payload)
      expect(allocatedWireBytes).toBeLessThanOrEqual(reservation)
      const changed = Buffer.concat([objects.raw.payload, Buffer.from([1])])
      expect(
        Result.isFailure(verifyResearchCaptureExport([{ ...exported[0]!, raw: changed }], sealBytes, manifest)),
      ).toBe(true)
      const originalIndex = Result.getOrThrow(
        Schema.decodeUnknownResult(Schema.fromJsonString(ResearchCaptureByteIndexSchema))(text(objects.index).payload),
      )
      const corrupted = [
        { ...originalIndex, captureId: 'another-worker' },
        { ...originalIndex, previousIndexHash: 'f'.repeat(64) },
        {
          ...originalIndex,
          ranges: originalIndex.ranges.map((range) => ({ ...range, receiptSequence: range.receiptSequence + 1 })),
        },
        {
          ...originalIndex,
          ranges: originalIndex.ranges.map((range) => ({
            ...range,
            byteOffset: range.byteOffset === null ? 0 : range.byteOffset + 1,
          })),
        },
      ]
      for (const [index, value] of corrupted.entries()) {
        if (index >= 2 && values.length === 0) continue
        const changedIndex = text(researchCaptureObject(JSON.stringify(value)))
        const changedSeal = encodeResearchCapture({
          ...seal,
          exportRoot: {
            schemaVersion: 'bayn.research-capture-export-root.v1',
            exportedChunks: 1,
            lastIndexHash: changedIndex.contentHash,
          },
        })
        const changedManifest = text(Result.getOrThrow(deriveResearchCaptureExportManifest(changedSeal)))
        expect(
          Result.isFailure(
            verifyResearchCaptureExport(
              [{ metadata, raw: objects.raw.payload, index: changedIndex }],
              changedSeal,
              changedManifest,
            ),
          ),
        ).toBe(true)
      }
    }),
    { numRuns: 500, seed: 20261003 },
  )
})

test('maximum JSON-escaped capture identities fit the chunk and terminal envelope reservation', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const recorder = yield* makeResearchCaptureRecorder(
        saved.store,
        { ...options, captureId: '\u0000'.repeat(512) },
        saved.objectStore,
      )
      recorder.record(captureEvent('STARTED'), 100)
      recorder.record(captureEvent('STOPPED'), 100)
      const reserved = (yield* recorder.status).retainedPayloadBytes
      yield* recorder.finish
      expect(Result.getOrThrow(saved.verify()).structurallyClosed).toBe(true)
      expect(
        3 * saved.objects.slice(0, 3).reduce((sum, object) => sum + object.payload.byteLength, 0),
      ).toBeLessThanOrEqual(reserved)
      expect(
        3 * saved.objects.slice(3).reduce((sum, object) => sum + object.payload.byteLength, 0),
      ).toBeLessThanOrEqual(researchCaptureExportEnvelopeReservation)
    }),
  ))

test('periodic drains form one immutable index chain and a different worker cannot repair its tail', () =>
  run(
    Effect.gen(function* () {
      yield* TestClock.setTime(100)
      const saved = memory()
      const recorder = yield* makeResearchCaptureRecorder(saved.store, options, saved.objectStore)
      recorder.record(captureEvent('STARTED'), 100)
      recorder.record(marketEvent, 100, Buffer.from('é'))
      yield* TestClock.adjust(10)
      expect((yield* recorder.status).persistedReceipts).toBe(2)
      recorder.record(captureEvent('STOPPED'), 110)
      yield* recorder.finish
      expect(saved.chunks).toHaveLength(2)
      expect(Result.getOrThrow(saved.verify()).structurallyClosed).toBe(true)
      const bucket = new Map(saved.objects.map((object) => [researchCaptureObjectKey(object.contentHash), object]))
      const reads: string[] = []
      const recovered = Result.getOrThrow(
        recoverCaptureFromStoredObjects(saved.chunks, saved.seals[0], (key) => {
          reads.push(key)
          return bucket.get(key)
        }),
      )
      expect(recovered.seal.exportRoot?.exportedChunks).toBe(2)
      expect(recovered.structurallyClosed).toBe(true)
      expect(recovered.complete).toBe(false)
      expect(reads).toHaveLength(7)
      const second = saved.objects[5]
      const first = saved.objects[2]
      if (second === undefined || first === undefined) throw new Error('Expected two indexes')
      expect(JSON.parse(text(second).payload).previousIndexHash).toBe(first.contentHash)
      const restarted = memory()
      const replacement = yield* makeResearchCaptureRecorder(
        restarted.store,
        { ...options, captureId: 'new-worker' },
        restarted.objectStore,
      )
      replacement.record(captureEvent('STARTED'), 110)
      replacement.record(captureEvent('STOPPED'), 110)
      yield* replacement.finish
      const replacementSeal = restarted.seals[0]
      if (replacementSeal === undefined) throw new Error('Expected replacement seal')
      saved.seals[0] = replacementSeal
      expect(Result.isFailure(saved.verify())).toBe(true)
    }),
  ))

test.each([0, -1])('raw admission honors the exact conservative byte reservation with %s bytes of slack', (slack) =>
  run(
    Effect.gen(function* () {
      const saved = memory()
      const raw = Buffer.from('é')
      const bytes = Buffer.byteLength(JSON.stringify({ sequence: 1, observedAtMs: 100, event: marketEvent }))
      const limit =
        researchCaptureExportEnvelopeReservation + researchCaptureExportEntryReservation(bytes, raw.byteLength) + slack
      const recorder = yield* makeResearchCaptureRecorder(
        saved.store,
        { ...options, maximumQueuedBytes: limit },
        saved.objectStore,
      )
      recorder.record(marketEvent, 100, raw)
      const status = yield* recorder.status
      expect(status.retainedPayloadBytes).toBeLessThanOrEqual(limit)
      expect(status.retainedReceipts).toBe(slack === 0 ? 1 : 0)
      expect(status.invalidations).toEqual(slack === 0 ? [] : [CaptureInvalidation.Overflow])
      yield* recorder.finish
      expect(saved.chunks).toHaveLength(slack === 0 ? 1 : 0)
    }),
  ),
)

test.each(['manifest', 'sql-seal'] as const)(
  'committed %s with lost acknowledgement remains unqualified and is never repeated',
  (fault) =>
    run(
      Effect.gen(function* () {
        yield* TestClock.setTime(100)
        const saved = memory()
        let attempts = 0
        const recorder = yield* makeResearchCaptureRecorder(
          {
            ...saved.store,
            seal: (bytes) =>
              saved.store
                .seal(bytes)
                .pipe(
                  Effect.andThen(
                    fault === 'sql-seal'
                      ? Effect.fail(new ResearchCaptureFailure({ message: 'Seal acknowledgement lost' }))
                      : Effect.void,
                  ),
                ),
          },
          options,
          {
            putVerified: (object) =>
              Effect.gen(function* () {
                attempts++
                yield* saved.objectStore.putVerified(object)
                if (fault === 'manifest' && attempts === 5)
                  return yield* new ResearchCaptureFailure({ message: 'Manifest acknowledgement lost' })
              }),
          },
        )
        recorder.record(captureEvent('STARTED'), 100)
        recorder.record(captureEvent('STOPPED'), 100)
        const seal = yield* recorder.finish
        expect(yield* recorder.finish).toEqual(seal)
        expect(attempts).toBe(5)
        expect(seal?.invalidations).toContain(CaptureInvalidation.Persistence)
        expect((yield* recorder.status).exportManifestHash).toBeNull()
        const last = saved.objects.at(-1)
        if (last === undefined) throw new Error('Expected committed manifest')
        expect(JSON.parse(text(last).payload).qualification).toBe(CaptureQualification.Unqualified)
        expect(saved.seals).toHaveLength(fault === 'manifest' ? 0 : 1)
      }),
    ),
)

test('owner interruption cancels an in-flight raw drain, releases its reservation, and remains interruption', () =>
  run(
    Effect.gen(function* () {
      const saved = memory()
      const entered = yield* Deferred.make<void>()
      let cancelled = 0
      let first = true
      const owner = yield* Effect.scoped(
        Effect.gen(function* () {
          const recorder = yield* makeResearchCaptureRecorder(saved.store, options, {
            putVerified: (object) => {
              if (!first) return saved.objectStore.putVerified(object)
              first = false
              return Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    cancelled++
                  }),
                ),
              )
            },
          })
          recorder.record(captureEvent('STARTED'), 0)
          return yield* Effect.never
        }),
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust(10)
      yield* Deferred.await(entered)
      const cancellation = yield* Fiber.interrupt(owner).pipe(Effect.forkChild)
      yield* TestClock.adjust(100)
      yield* Fiber.await(cancellation)
      const exit = yield* Fiber.await(owner)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(cancelled).toBe(1)
      expect(saved.seals).toHaveLength(1)
      expect(JSON.parse(saved.seals[0]?.payload ?? '{}').qualification).toBe(CaptureQualification.Unqualified)
    }),
  ))
