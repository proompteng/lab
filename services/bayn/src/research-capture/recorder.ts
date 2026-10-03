import { randomUUID } from 'node:crypto'
import { Clock, Effect, Exit, Queue, Result, Schema, Semaphore } from 'effect'

import {
  CaptureInvalidation,
  CaptureQualification,
  ResearchCaptureFailure,
  ResearchCaptureIdSchema,
  ResearchCaptureReceiptSchema,
  encodeResearchCapture,
  maximumResearchCaptureChunkBytes,
  type ResearchCaptureBytes,
  type ResearchCaptureChunk,
  type ResearchCaptureEvent,
  type ResearchCaptureObserver,
  type ResearchCaptureReceipt,
  type ResearchCaptureSeal,
} from './capture'
import { GitSourceRevisionSchema, PositiveIntegerSchema, strictParseOptions } from '../schemas'
import { sha256 } from '../hash'
import {
  buildResearchCaptureExportChunk,
  persistResearchCaptureExportChunk,
  persistResearchCaptureExportSeal,
  researchCaptureExportEntryReservation,
  researchCaptureExportEnvelopeReservation,
  type ResearchCaptureObjectStore,
} from './export'

export interface ResearchCaptureStore {
  readonly append: (chunk: ResearchCaptureBytes) => Effect.Effect<void, ResearchCaptureFailure>
  readonly seal: (seal: ResearchCaptureBytes) => Effect.Effect<void, ResearchCaptureFailure>
}

const RecorderOptionsSchema = Schema.Struct({
  captureId: Schema.optionalKey(ResearchCaptureIdSchema),
  sourceRevision: GitSourceRevisionSchema,
  maximumQueuedReceipts: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(1024)),
  maximumQueuedBytes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(maximumResearchCaptureChunkBytes)),
  maximumReceiptBytes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(64 * 1024)),
  flushIntervalMs: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(1000)),
  writeTimeoutMs: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(1000)),
})

export interface ResearchCaptureRecorder extends ResearchCaptureObserver {
  readonly captureId: string
  readonly finish: Effect.Effect<ResearchCaptureSeal | undefined>
  readonly status: Effect.Effect<{
    readonly accepting: boolean
    readonly observedReceipts: number
    readonly persistedReceipts: number
    readonly invalidations: readonly CaptureInvalidation[]
    readonly retainedPayloadBytes: number
    readonly retainedReceipts: number
    readonly exportManifestHash: string | null
  }>
}

/** Explicit injection only. Production composition deliberately does not acquire this recorder. */
export const makeResearchCaptureRecorder = (
  store: ResearchCaptureStore,
  input: typeof RecorderOptionsSchema.Type,
  objectStore?: ResearchCaptureObjectStore,
) =>
  Effect.gen(function* () {
    const options = yield* Schema.decodeUnknownEffect(RecorderOptionsSchema, strictParseOptions)(input)
    if (options.maximumReceiptBytes > options.maximumQueuedBytes)
      return yield* new ResearchCaptureFailure({ message: 'A receipt cannot exceed the bounded capture buffer' })
    if (objectStore !== undefined && options.maximumQueuedBytes <= researchCaptureExportEnvelopeReservation)
      return yield* new ResearchCaptureFailure({
        message: 'Raw capture buffer cannot hold its bounded export envelopes',
      })
    const clock = yield* Clock.Clock
    const captureId = options.captureId ?? (yield* Effect.sync(randomUUID))
    const queue = yield* Queue.make<{
      readonly receipt: ResearchCaptureReceipt
      readonly bytes: number
      readonly reservation: number
      readonly rawValue?: Uint8Array | null
    }>({
      capacity: options.maximumQueuedReceipts,
      strategy: 'dropping',
    })
    const serial = yield* Semaphore.make(1)
    const invalidations = new Set<CaptureInvalidation>()
    let accepting = true
    let observedReceipts = 0
    let persistedReceipts = 0
    let persistedChunks = 0
    let previousContentHash: string | null = null
    let queuedBytes = objectStore === undefined ? 0 : researchCaptureExportEnvelopeReservation
    let retainedReceipts = 0
    let previousIndexHash: string | null = null
    let exportManifestHash: string | null = null
    let lastObservedAtMs = 0
    let finished: ResearchCaptureSeal | undefined
    let finalized = false
    const invalidate = (reason: CaptureInvalidation): void => {
      invalidations.add(reason)
    }
    const record = (event: ResearchCaptureEvent, observedAtMs?: number, rawValue?: Uint8Array | null): void => {
      if (!accepting) return
      observedReceipts++
      if (invalidations.size !== 0) return
      const result = Result.try(() => {
        const atMs = observedAtMs ?? clock.currentTimeMillisUnsafe()
        if (atMs < lastObservedAtMs) {
          invalidate(CaptureInvalidation.ClockReversed)
          return
        }
        const candidate = { sequence: observedReceipts, observedAtMs: atMs, event }
        const decoded = Schema.decodeUnknownResult(ResearchCaptureReceiptSchema, strictParseOptions)(candidate)
        if (Result.isFailure(decoded)) {
          invalidate(CaptureInvalidation.InvalidEvent)
          return
        }
        const payload = JSON.stringify(candidate)
        const retained = Schema.decodeUnknownResult(
          Schema.fromJsonString(ResearchCaptureReceiptSchema),
          strictParseOptions,
        )(payload)
        if (Result.isFailure(retained)) {
          invalidate(CaptureInvalidation.InvalidEvent)
          return
        }
        const bytes = Buffer.byteLength(JSON.stringify(retained.success), 'utf8')
        if (objectStore !== undefined && event.kind === 'market-record') {
          if (
            event.tombstone
              ? rawValue !== null || event.rawValueSha256 !== null || event.rawByteLength !== null
              : !(rawValue instanceof Uint8Array) || rawValue.byteLength !== event.rawByteLength
          ) {
            invalidate(CaptureInvalidation.MissingRawIdentity)
            return
          }
        }
        const rawBytes = objectStore === undefined || event.kind !== 'market-record' ? 0 : (rawValue?.byteLength ?? 0)
        const reservation = objectStore === undefined ? bytes : researchCaptureExportEntryReservation(bytes, rawBytes)
        if (
          bytes > options.maximumReceiptBytes ||
          queuedBytes + reservation > options.maximumQueuedBytes ||
          (objectStore !== undefined && retainedReceipts >= options.maximumQueuedReceipts)
        ) {
          invalidate(CaptureInvalidation.Overflow)
          return
        }
        if (
          objectStore !== undefined &&
          event.kind === 'market-record' &&
          rawValue instanceof Uint8Array &&
          sha256(rawValue) !== event.rawValueSha256
        ) {
          invalidate(CaptureInvalidation.MissingRawIdentity)
          return
        }
        const ownedRaw =
          objectStore !== undefined && event.kind === 'market-record'
            ? { rawValue: rawValue instanceof Uint8Array ? Buffer.from(rawValue) : null }
            : {}
        if (!Queue.offerUnsafe(queue, { receipt: retained.success, bytes, reservation, ...ownedRaw })) {
          invalidate(CaptureInvalidation.Overflow)
          return
        }
        queuedBytes += reservation
        retainedReceipts++
        lastObservedAtMs = atMs
      })
      if (Result.isFailure(result)) invalidate(CaptureInvalidation.InvalidEvent)
    }
    const boundedWrite = (write: () => Effect.Effect<void, ResearchCaptureFailure>) =>
      Effect.suspend(write).pipe(
        Effect.timeoutOrElse({
          duration: options.writeTimeoutMs,
          orElse: () => Effect.fail(new ResearchCaptureFailure({ message: 'Capture write outcome is unknown' })),
        }),
        Effect.catchCause(() =>
          Effect.sync(() => {
            invalidate(CaptureInvalidation.Persistence)
          }),
        ),
      )
    const drain = Effect.gen(function* () {
      const entries = yield* Queue.clear(queue)
      if (entries.length === 0) return
      const reservation = entries.reduce((sum, entry) => sum + entry.reservation, 0)
      const release = () => {
        queuedBytes -= reservation
        retainedReceipts -= entries.length
      }
      if (objectStore === undefined) release()
      yield* Effect.gen(function* () {
        if (invalidations.has(CaptureInvalidation.Persistence)) return
        let start = 0
        while (start < entries.length) {
          const chunk: ResearchCaptureChunk = {
            schemaVersion: 'bayn.research-capture-chunk.v1',
            captureId,
            sourceRevision: options.sourceRevision,
            chunkOrdinal: persistedChunks,
            previousContentHash,
            receipts: [],
          }
          let size = Buffer.byteLength(JSON.stringify(chunk), 'utf8')
          let end = start
          while (end < entries.length) {
            const entry = entries[end]
            if (entry === undefined) break
            const addedBytes = entry.bytes + (end === start ? 0 : 1)
            if (size + addedBytes > maximumResearchCaptureChunkBytes) break
            size += addedBytes
            end++
          }
          if (end === start) {
            invalidate(CaptureInvalidation.Overflow)
            return
          }
          const completeChunk = {
            ...chunk,
            receipts: entries.slice(start, end).map((entry) => entry.receipt),
          }
          const bytes = encodeResearchCapture(completeChunk)
          let verifiedIndexHash = previousIndexHash
          yield* boundedWrite(() =>
            Effect.gen(function* () {
              if (objectStore !== undefined) {
                const objects = buildResearchCaptureExportChunk(
                  completeChunk,
                  bytes,
                  entries.slice(start, end),
                  previousIndexHash,
                )
                verifiedIndexHash = yield* persistResearchCaptureExportChunk(objectStore, objects)
              }
              yield* store.append(bytes)
            }),
          )
          if (invalidations.has(CaptureInvalidation.Persistence)) return
          previousIndexHash = verifiedIndexHash
          persistedChunks++
          previousContentHash = bytes.contentHash
          persistedReceipts = entries[end - 1]?.receipt.sequence ?? persistedReceipts
          start = end
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (objectStore !== undefined) release()
          }),
        ),
      )
    })
    const worker = Effect.gen(function* () {
      while (accepting) {
        yield* Effect.sleep(options.flushIntervalMs)
        yield* serial.withPermit(drain)
      }
    })
    yield* worker.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) && accepting) invalidate(CaptureInvalidation.Interrupted)
        }),
      ),
      Effect.forkScoped,
    )
    const finish = Effect.suspend(() => {
      accepting = false
      return serial.withPermit(
        Effect.gen(function* () {
          if (finalized) return finished
          finalized = true
          yield* drain
          const seal: ResearchCaptureSeal = {
            schemaVersion: 'bayn.research-capture-seal.v1',
            qualification: CaptureQualification.Unqualified,
            captureId,
            sourceRevision: options.sourceRevision,
            closedAtMs: clock.currentTimeMillisUnsafe(),
            observedReceipts,
            persistedReceipts,
            persistedChunks,
            lastContentHash: previousContentHash,
            invalidations: [...invalidations],
          }
          let verifiedManifestHash: string | null = null
          let sealAcknowledged = false
          yield* boundedWrite(() =>
            Effect.gen(function* () {
              const bytes = encodeResearchCapture(seal)
              if (objectStore !== undefined)
                verifiedManifestHash = yield* persistResearchCaptureExportSeal(objectStore, bytes, previousIndexHash)
              yield* store.seal(bytes)
              sealAcknowledged = true
            }),
          )
          if (sealAcknowledged) exportManifestHash = verifiedManifestHash
          finished = { ...seal, invalidations: [...invalidations] }
          return finished
        }),
      )
    }).pipe(
      Effect.catchCause(() =>
        Effect.sync(() => {
          finalized = true
          invalidate(CaptureInvalidation.Finalization)
          return undefined
        }),
      ),
    )
    yield* Effect.addFinalizer((exit) => {
      if (!finalized && Exit.isFailure(exit)) invalidate(CaptureInvalidation.Interrupted)
      return finish.pipe(Effect.asVoid)
    })
    return {
      captureId,
      ...(objectStore === undefined ? {} : { rawValues: true }),
      record,
      invalidate,
      finish,
      status: Effect.sync(() => ({
        accepting,
        observedReceipts,
        persistedReceipts,
        invalidations: [...invalidations],
        retainedPayloadBytes: queuedBytes,
        retainedReceipts,
        exportManifestHash,
      })),
    } satisfies ResearchCaptureRecorder
  })
