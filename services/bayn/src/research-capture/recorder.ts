import { randomUUID } from 'node:crypto'
import { Clock, Effect, Exit, Queue, Result, Schema, Semaphore } from 'effect'

import {
  CaptureInvalidation,
  ResearchCaptureFailure,
  ResearchCaptureReceiptSchema,
  encodeResearchCapture,
  type ResearchCaptureBytes,
  type ResearchCaptureChunk,
  type ResearchCaptureEvent,
  type ResearchCaptureObserver,
  type ResearchCaptureReceipt,
  type ResearchCaptureSeal,
} from './capture'
import {
  GitSourceRevisionSchema,
  PositiveIntegerSchema,
  StrictNonEmptyStringSchema,
  strictParseOptions,
} from '../schemas'

export interface ResearchCaptureStore {
  readonly append: (chunk: ResearchCaptureBytes) => Effect.Effect<void, ResearchCaptureFailure>
  readonly seal: (seal: ResearchCaptureBytes) => Effect.Effect<void, ResearchCaptureFailure>
}

const RecorderOptionsSchema = Schema.Struct({
  captureId: Schema.optionalKey(StrictNonEmptyStringSchema),
  sourceRevision: GitSourceRevisionSchema,
  maximumQueuedReceipts: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(1024)),
  maximumQueuedBytes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(4 * 1024 * 1024)),
  maximumReceiptBytes: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(64 * 1024)),
  flushIntervalMs: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(1000)),
  writeTimeoutMs: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(1000)),
})

export interface ResearchCaptureRecorder extends ResearchCaptureObserver {
  readonly captureId: string
  readonly finish: Effect.Effect<ResearchCaptureSeal>
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
        const bytes = Buffer.byteLength(payload, 'utf8')
        const retained = Schema.decodeUnknownResult(
          Schema.fromJsonString(ResearchCaptureReceiptSchema),
          strictParseOptions,
        )(payload)
        if (Result.isFailure(retained)) {
          invalidate(CaptureInvalidation.InvalidEvent)
          return
        }
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
      const entries = yield* Queue.takeAll(queue)
      if (entries.length === 0) return
      queuedBytes -= entries.reduce((sum, entry) => sum + entry.bytes, 0)
      const chunk: ResearchCaptureChunk = {
        schemaVersion: 'bayn.research-capture-chunk.v1',
        captureId,
        sourceRevision: options.sourceRevision,
        chunkOrdinal: persistedChunks,
        previousContentHash,
        receipts: entries.map((entry) => entry.receipt),
      }
      const bytes = encodeResearchCapture(chunk)
      const priorFailure = invalidations.has(CaptureInvalidation.Persistence)
      if (priorFailure) return
      yield* boundedWrite(() => store.append(bytes))
      if (invalidations.has(CaptureInvalidation.Persistence)) return
      persistedChunks++
      previousContentHash = bytes.contentHash
      persistedReceipts = entries[entries.length - 1]?.receipt.sequence ?? persistedReceipts
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
          if (finished !== undefined) return finished
          yield* drain
          const seal: ResearchCaptureSeal = {
            schemaVersion: 'bayn.research-capture-seal.v1',
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
    })
    yield* Effect.addFinalizer((exit) => {
      if (Exit.isFailure(exit)) invalidate(CaptureInvalidation.Interrupted)
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
