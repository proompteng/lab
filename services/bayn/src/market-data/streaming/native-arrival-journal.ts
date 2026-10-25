import { Cause, Effect, Exit, Fiber, Queue, Result, Semaphore, type Scope } from 'effect'

import type { KafkaBootstrapEvidence } from './bootstrap'
import type { MarketSources } from './raw-events'
import { reportNativeArrivalFailure } from '../../error-tracking'
import {
  makeNativeArrivalChunk,
  nativeArrival,
  NativeArrivalCaptureError,
  type NativeArrival,
  type NativeArrivalChunk,
  type NativeArrivalEpoch,
  type NativeArrivalObservation,
} from './native-arrival'

export interface NativeArrivalEnd {
  readonly captureId: string
  readonly status: 'STOPPED' | 'INCOMPLETE'
  readonly observedConsumerSequence: number
  readonly durableConsumerSequence: number
  readonly lastChunkHash: string | null
  readonly reason: string | null
  readonly consumerScopeCompleted: boolean
}

export interface NativeArrivalStore {
  readonly begin: (epoch: NativeArrivalEpoch) => Effect.Effect<void, NativeArrivalCaptureError>
  readonly append: (chunks: readonly NativeArrivalChunk[]) => Effect.Effect<void, NativeArrivalCaptureError>
  readonly end: (end: NativeArrivalEnd) => Effect.Effect<void, NativeArrivalCaptureError>
}

export interface NativeArrivalCapture {
  readonly observe: (input: NativeArrivalObservation) => Effect.Effect<void>
  readonly status: () => {
    readonly captureId: string
    readonly status: 'RECORDING' | 'INCOMPLETE' | 'STOPPED'
    readonly observedConsumerSequence: number
    readonly durableConsumerSequence: number
    readonly queuedCompressedBytes: number
    readonly failure: string | null
  }
}

export type NativeArrivalCaptureFactory = (
  bootstrap: KafkaBootstrapEvidence,
  sources: MarketSources,
) => Effect.Effect<NativeArrivalCapture, NativeArrivalCaptureError, Scope.Scope>

export const makeNativeArrivalJournal = (
  epoch: NativeArrivalEpoch,
  store: NativeArrivalStore,
  bounds = { chunkBytes: 256 * 1024, queueBytes: 64 * 1024 * 1024 },
): Effect.Effect<NativeArrivalCapture, NativeArrivalCaptureError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* store.begin(epoch)
    const wake = yield* Queue.dropping<void>(1)
    const space = yield* Queue.dropping<void>(1)
    const buffer = yield* Semaphore.make(1)
    let state: 'RECORDING' | 'INCOMPLETE' | 'STOPPED' = 'RECORDING'
    let failure: NativeArrivalCaptureError | undefined
    let records: NativeArrival[] = []
    let recordBytes = 0
    let ordinal = 0
    let previousHash: string | null = null
    let durableHash: string | null = null
    let observedSequence = 0
    let durableSequence = 0
    let queuedBytes = 0
    const pending: NativeArrivalChunk[] = []
    const fail = (cause: NativeArrivalCaptureError) => {
      if (failure !== undefined) return
      failure = cause
      state = 'INCOMPLETE'
      records = []
      recordBytes = 0
      Queue.offerUnsafe(wake, undefined)
      Queue.offerUnsafe(space, undefined)
    }
    const flush = Effect.gen(function* () {
      if (state !== 'RECORDING' || records.length === 0) return
      const chunk = makeNativeArrivalChunk(epoch, ordinal, previousHash, records)
      if (Result.isFailure(chunk)) return fail(chunk.failure)
      if (chunk.success.compressed.byteLength > bounds.queueBytes)
        return fail(
          new NativeArrivalCaptureError({ message: 'Native arrival chunk exceeds the compressed queue byte bound' }),
        )
      while (state === 'RECORDING' && queuedBytes + chunk.success.compressed.byteLength > bounds.queueBytes)
        yield* Queue.take(space)
      if (state !== 'RECORDING') return
      records = []
      recordBytes = 0
      pending.push(chunk.success)
      queuedBytes += chunk.success.compressed.byteLength
      ordinal++
      previousHash = chunk.success.contentHash
      Queue.offerUnsafe(wake, undefined)
    })
    const drain = Effect.gen(function* () {
      while (pending.length > 0) {
        const batch: NativeArrivalChunk[] = []
        let bytes = 0
        for (const chunk of pending) {
          if (batch.length > 0 && (batch.length >= 256 || bytes + chunk.compressed.byteLength > 8 * 1024 * 1024)) break
          batch.push(chunk)
          bytes += chunk.compressed.byteLength
        }
        yield* store.append(batch)
        for (const chunk of batch) {
          pending.shift()
          queuedBytes -= chunk.compressed.byteLength
          durableSequence = chunk.header.lastConsumerSequence
          durableHash = chunk.contentHash
        }
        Queue.offerUnsafe(space, undefined)
      }
    })
    let reportedFailure = false
    let closing = false
    const reportFailure = (cause: NativeArrivalCaptureError) =>
      Effect.sync(() => {
        fail(cause)
        reportedFailure = true
      }).pipe(
        Effect.andThen(Effect.logError('Native market arrival retention is incomplete', cause)),
        Effect.andThen(reportNativeArrivalFailure(cause)),
        Effect.annotateLogs({ captureId: epoch.captureId, consumerEpoch: epoch.bootstrap.epoch }),
      )
    const worker = yield* Effect.forever(
      Queue.take(wake).pipe(
        Effect.andThen(drain),
        Effect.andThen(
          Effect.suspend(() => {
            if (failure === undefined || reportedFailure) return Effect.void
            return reportFailure(failure)
          }),
        ),
      ),
    ).pipe(
      Effect.catchTag('NativeArrivalCaptureError', reportFailure),
      Effect.onExit((exit) =>
        closing || state !== 'RECORDING'
          ? Effect.void
          : reportFailure(
              new NativeArrivalCaptureError({
                message: 'Native arrival writer stopped before owner shutdown',
                cause: Exit.isFailure(exit) ? exit.cause : undefined,
              }),
            ),
      ),
      Effect.forkScoped,
    )
    const ticker = yield* Effect.forever(Effect.sleep('1 second').pipe(Effect.andThen(buffer.withPermit(flush)))).pipe(
      Effect.forkScoped,
    )
    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        closing = true
        yield* Fiber.interrupt(ticker)
        yield* Fiber.interrupt(worker)
        yield* drain
        yield* flush
        if (failure !== undefined && !reportedFailure) yield* reportFailure(failure)
        yield* drain
        if (state === 'RECORDING' && observedSequence !== durableSequence)
          yield* reportFailure(
            new NativeArrivalCaptureError({
              message: 'Native arrival shutdown did not retain every observed delivery',
            }),
          )
        if (state === 'RECORDING') state = 'STOPPED'
        yield* store.end({
          captureId: epoch.captureId,
          status: state === 'STOPPED' ? 'STOPPED' : 'INCOMPLETE',
          observedConsumerSequence: observedSequence,
          durableConsumerSequence: durableSequence,
          lastChunkHash: durableHash,
          reason: failure?.message ?? null,
          consumerScopeCompleted: Exit.isSuccess(exit),
        })
      }).pipe(
        Effect.timeout('5 seconds'),
        Effect.catchCause((cause) =>
          reportFailure(
            new NativeArrivalCaptureError({
              message: 'Native arrival finalization did not confirm a sealed prefix',
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      ),
    )
    return {
      observe: (input) =>
        Effect.suspend(() => {
          const previousObservedSequence = observedSequence
          observedSequence = input.consumerSequence
          return buffer.withPermit(
            Effect.gen(function* () {
              const previousOrdinal = ordinal
              if (state !== 'RECORDING') return
              if (
                input.consumerSequence !== previousObservedSequence + 1 ||
                (input.record.tombstone === true
                  ? input.record.rawValue !== null || input.record.rawValueSha256 !== null
                  : input.record.rawValue === undefined ||
                    input.record.rawValue === null ||
                    input.record.rawValueSha256 === undefined ||
                    input.record.rawValueSha256 === null ||
                    input.record.rawByteLength !== input.record.rawValue.byteLength)
              )
                return fail(
                  new NativeArrivalCaptureError({
                    message: 'Native arrival transport bytes or consumer sequence are missing',
                  }),
                )
              const record = nativeArrival(epoch, input)
              const bytes = Buffer.byteLength(JSON.stringify(record)) + 1
              if (bytes > 4 * 1024 * 1024)
                return fail(
                  new NativeArrivalCaptureError({ message: 'Native arrival exceeds the bounded record size' }),
                )
              if (recordBytes + bytes > 4 * 1024 * 1024) yield* flush
              if (state !== 'RECORDING') return
              records.push(record)
              recordBytes += bytes
              if (recordBytes >= bounds.chunkBytes) yield* flush
              if (ordinal !== previousOrdinal) yield* Effect.yieldNow
            }),
          )
        }),
      status: () => ({
        captureId: epoch.captureId,
        status: state,
        observedConsumerSequence: observedSequence,
        durableConsumerSequence: durableSequence,
        queuedCompressedBytes: queuedBytes,
        failure: failure?.message ?? null,
      }),
    }
  })
