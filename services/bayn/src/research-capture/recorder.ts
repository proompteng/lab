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
  }>
}

/** Explicit injection only. Production composition deliberately does not acquire this recorder. */
export const makeResearchCaptureRecorder = (store: ResearchCaptureStore, input: typeof RecorderOptionsSchema.Type) =>
  Effect.gen(function* () {
    const options = yield* Schema.decodeUnknownEffect(RecorderOptionsSchema, strictParseOptions)(input)
    if (options.maximumReceiptBytes > options.maximumQueuedBytes)
      return yield* new ResearchCaptureFailure({ message: 'A receipt cannot exceed the bounded capture buffer' })
    const clock = yield* Clock.Clock
    const captureId = options.captureId ?? (yield* Effect.sync(randomUUID))
    const queue = yield* Queue.make<{ readonly receipt: ResearchCaptureReceipt; readonly bytes: number }>({
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
    let queuedBytes = 0
    let lastObservedAtMs = 0
    let finished: ResearchCaptureSeal | undefined
    let finalized = false
    const invalidate = (reason: CaptureInvalidation): void => {
      invalidations.add(reason)
    }
    const record = (event: ResearchCaptureEvent, observedAtMs?: number): void => {
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
        if (
          bytes > options.maximumReceiptBytes ||
          queuedBytes + bytes > options.maximumQueuedBytes ||
          !Queue.offerUnsafe(queue, { receipt: retained.success, bytes })
        ) {
          invalidate(CaptureInvalidation.Overflow)
          return
        }
        queuedBytes += bytes
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
      queuedBytes -= entries.reduce((sum, entry) => sum + entry.bytes, 0)
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
        const bytes = encodeResearchCapture({
          ...chunk,
          receipts: entries.slice(start, end).map((entry) => entry.receipt),
        })
        yield* boundedWrite(() => store.append(bytes))
        if (invalidations.has(CaptureInvalidation.Persistence)) return
        persistedChunks++
        previousContentHash = bytes.contentHash
        persistedReceipts = entries[end - 1]?.receipt.sequence ?? persistedReceipts
        start = end
      }
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
          yield* boundedWrite(() => store.seal(encodeResearchCapture(seal)))
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
      record,
      invalidate,
      finish,
      status: Effect.sync(() => ({
        accepting,
        observedReceipts,
        persistedReceipts,
        invalidations: [...invalidations],
      })),
    } satisfies ResearchCaptureRecorder
  })
