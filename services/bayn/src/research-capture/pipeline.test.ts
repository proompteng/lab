import { expect, test } from 'bun:test'
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../effect-test-support'
import {
  CaptureInvalidation,
  ResearchCaptureFailure,
  decodeResearchCaptureChunk,
  decodeResearchCaptureSeal,
  type ResearchCaptureBytes,
} from './capture'
import { captureEvent } from './capture.test-support'
import {
  ResearchCaptureByteIndexSchema,
  researchCaptureExportEnvelopeReservation,
  researchCaptureExportEntryReservation,
  type ResearchCaptureObjectStore,
} from './export'
import { makeResearchCaptureRecorder, type ResearchCaptureStore } from './recorder'

const options = {
  captureId: 'capture-pipeline',
  sourceRevision: 'a'.repeat(40),
  maximumQueuedReceipts: 32,
  maximumQueuedBytes: 256 * 1024,
  maximumReceiptBytes: 4096,
  flushIntervalMs: 10,
  writeTimeoutMs: 1000,
}
const run = <A, E>(effect: Effect.Effect<A, E, import('effect').Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(provideTestLayer(TestClock.layer())))
const indexOf = (bytes: Uint8Array) =>
  Schema.decodeUnknownResult(Schema.fromJsonString(ResearchCaptureByteIndexSchema))(Buffer.from(bytes).toString('utf8'))

test('the next raw chunk verifies while current SQL waits, without appending it before the current acknowledgement', () =>
  run(
    Effect.gen(function* () {
      const firstObject = yield* Deferred.make<void>()
      const releaseObject = yield* Deferred.make<void>()
      const firstSql = yield* Deferred.make<void>()
      const releaseSql = yield* Deferred.make<void>()
      const nextObject = yield* Deferred.make<void>()
      const chunks: ResearchCaptureBytes[] = []
      const events: string[] = []
      const store: ResearchCaptureStore = {
        append: (bytes) =>
          Effect.gen(function* () {
            const chunk = Result.getOrThrow(decodeResearchCaptureChunk(bytes))
            events.push(`sql:${chunk.chunkOrdinal}`)
            if (chunk.chunkOrdinal === 0) {
              yield* Deferred.succeed(firstSql, undefined)
              yield* Deferred.await(releaseSql)
            }
            chunks.push(bytes)
            events.push(`ack:${chunk.chunkOrdinal}`)
          }),
        seal: () => Effect.void,
      }
      const objects: ResearchCaptureObjectStore = {
        putVerified: (object) =>
          Effect.gen(function* () {
            const decoded = indexOf(object.payload)
            if (Result.isFailure(decoded)) return
            const ordinal = decoded.success.chunkOrdinal
            if (ordinal === 0) {
              yield* Deferred.succeed(firstObject, undefined)
              yield* Deferred.await(releaseObject)
            }
            events.push(`object:${ordinal}`)
            if (ordinal === 1) yield* Deferred.succeed(nextObject, undefined)
          }),
      }
      const recorder = yield* makeResearchCaptureRecorder(store, options, objects)
      recorder.record(captureEvent('STARTED'), 100)
      yield* TestClock.adjust(10)
      yield* Deferred.await(firstObject)
      recorder.record(captureEvent('STOPPED'), 100)
      yield* Deferred.succeed(releaseObject, undefined)
      yield* Deferred.await(firstSql)
      yield* TestClock.adjust(1)
      const overlapped = Deferred.isDoneUnsafe(nextObject)
      const beforeAck = [...events]
      yield* Deferred.succeed(releaseSql, undefined)
      const seal = yield* recorder.finish
      expect(overlapped).toBe(true)
      expect(beforeAck).toEqual(['object:0', 'sql:0', 'object:1'])
      expect(events).toEqual(['object:0', 'sql:0', 'object:1', 'ack:0', 'sql:1', 'ack:1'])
      expect(chunks).toHaveLength(2)
      expect(seal?.persistedReceipts).toBe(2)
      expect(seal?.invalidations).toEqual([])
    }),
  ))

type PipelineFault =
  | 'none'
  | 'sql-before-commit'
  | 'sql-ack-lost'
  | 'object-ack-lost'
  | 'object-defect'
  | 'object-interrupt'
const blockedPipeline = (
  fault: PipelineFault = 'none',
  maximumQueuedReceipts = 32,
  maximumQueuedBytes = options.maximumQueuedBytes,
  recorderClock?: Clock.Clock,
) =>
  Effect.gen(function* () {
    const firstObject = yield* Deferred.make<void>()
    const releaseFirstObject = yield* Deferred.make<void>()
    const firstSql = yield* Deferred.make<void>()
    const releaseSql = yield* Deferred.make<void>()
    const nextObject = yield* Deferred.make<void>()
    const releaseNextObject = yield* Deferred.make<void>()
    const secondSql = yield* Deferred.make<void>()
    const releaseSecondSql = yield* Deferred.make<void>()
    const chunks: ResearchCaptureBytes[] = []
    const seals: ResearchCaptureBytes[] = []
    const appends: number[] = []
    let blockSecondSql = false
    let nextObjectFinalized = false
    let firstSqlFinalized = false
    const store: ResearchCaptureStore = {
      append: (bytes) =>
        Effect.gen(function* () {
          const chunk = Result.getOrThrow(decodeResearchCaptureChunk(bytes))
          appends.push(chunk.chunkOrdinal)
          if (chunk.chunkOrdinal === 0) {
            yield* Deferred.succeed(firstSql, undefined)
            yield* Deferred.await(releaseSql).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  firstSqlFinalized = true
                }),
              ),
            )
            if (fault === 'sql-before-commit')
              return yield* new ResearchCaptureFailure({ message: 'SQL failed before commit' })
          }
          if (chunk.chunkOrdinal === 1 && blockSecondSql) {
            yield* Deferred.succeed(secondSql, undefined)
            yield* Deferred.await(releaseSecondSql)
          }
          chunks.push(bytes)
          if (fault === 'sql-ack-lost')
            return yield* new ResearchCaptureFailure({ message: 'SQL committed; acknowledgement lost' })
        }),
      seal: (bytes) =>
        Effect.gen(function* () {
          const seal = Result.getOrThrow(decodeResearchCaptureSeal(bytes))
          const last = chunks.at(-1)
          if (seal.persistedChunks !== chunks.length || seal.lastContentHash !== (last?.contentHash ?? null))
            return yield* new ResearchCaptureFailure({ message: 'Seal omits the committed tail' })
          seals.push(bytes)
        }),
    }
    const objects: ResearchCaptureObjectStore = {
      putVerified: (object) =>
        Effect.gen(function* () {
          const index = indexOf(object.payload)
          if (Result.isFailure(index)) return
          if (index.success.chunkOrdinal === 0) {
            yield* Deferred.succeed(firstObject, undefined)
            yield* Deferred.await(releaseFirstObject)
          }
          if (index.success.chunkOrdinal === 1) {
            yield* Effect.gen(function* () {
              yield* Deferred.succeed(nextObject, undefined)
              yield* Deferred.await(releaseNextObject)
              if (fault === 'object-ack-lost')
                return yield* new ResearchCaptureFailure({ message: 'Object committed; acknowledgement lost' })
              if (fault === 'object-defect') return yield* Effect.die(new Error('Object sink defect'))
              if (fault === 'object-interrupt') return yield* Effect.interrupt
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  nextObjectFinalized = true
                }),
              ),
            )
          }
        }),
    }
    const acquisition = makeResearchCaptureRecorder(
      store,
      { ...options, maximumQueuedReceipts, maximumQueuedBytes },
      objects,
    )
    const recorder = yield* recorderClock === undefined
      ? acquisition
      : acquisition.pipe(Effect.provideService(Clock.Clock, recorderClock))
    recorder.record(captureEvent('STARTED'), 100)
    yield* TestClock.adjust(10)
    yield* Deferred.await(firstObject)
    recorder.record(captureEvent('STOPPED'), 100)
    yield* Deferred.succeed(releaseFirstObject, undefined)
    yield* Deferred.await(firstSql)
    yield* Deferred.await(nextObject)
    return {
      recorder,
      chunks,
      seals,
      appends,
      releaseSql,
      releaseNextObject,
      secondSql,
      releaseSecondSql,
      blockSecond: () => {
        blockSecondSql = true
      },
      finalized: () => ({ firstSqlFinalized, nextObjectFinalized }),
    }
  })

test('queued, SQL-current and object-lookahead receipts keep their reservations until each acknowledgement', () =>
  run(
    Effect.gen(function* () {
      const h = yield* blockedPipeline('none', 3)
      const two = yield* h.recorder.status
      expect(two.retainedReceipts).toBe(2)
      h.recorder.record(captureEvent('STOPPED'), 100)
      const three = yield* h.recorder.status
      expect(three.retainedReceipts).toBe(3)
      expect(three.retainedPayloadBytes).toBeGreaterThan(two.retainedPayloadBytes)
      h.recorder.record(captureEvent('STOPPED'), 100)
      expect((yield* h.recorder.status).invalidations).toContain(CaptureInvalidation.Overflow)
      expect((yield* h.recorder.status).retainedReceipts).toBe(3)
      yield* Deferred.succeed(h.releaseSql, undefined)
      yield* TestClock.adjust(1)
      const acknowledged = yield* h.recorder.status
      expect(acknowledged.persistedReceipts).toBe(1)
      expect(acknowledged.retainedReceipts).toBe(2)
      expect(acknowledged.retainedPayloadBytes).toBeLessThan(three.retainedPayloadBytes)
      expect(h.finalized().nextObjectFinalized).toBe(false)
      yield* Deferred.succeed(h.releaseNextObject, undefined)
      const seal = yield* h.recorder.finish
      expect(seal?.persistedReceipts).toBe(3)
      expect(seal?.observedReceipts).toBe(4)
      expect((yield* h.recorder.status).retainedPayloadBytes).toBe(researchCaptureExportEnvelopeReservation)
      expect((yield* h.recorder.status).retainedReceipts).toBe(0)
    }),
  ))

test.each([
  ['sql-before-commit', false],
  ['sql-before-commit', true],
  ['sql-ack-lost', false],
  ['sql-ack-lost', true],
] as const)(
  '%s forbids successor SQL and an omitted-tail seal whether lookahead already verified=%s',
  (fault, verified) =>
    run(
      Effect.gen(function* () {
        const h = yield* blockedPipeline(fault)
        if (verified) {
          yield* Deferred.succeed(h.releaseNextObject, undefined)
          yield* TestClock.adjust(1)
        }
        yield* Deferred.succeed(h.releaseSql, undefined)
        const seal = yield* h.recorder.finish
        expect(h.appends).toEqual([0])
        expect(h.finalized().nextObjectFinalized).toBe(true)
        expect(seal?.persistedReceipts).toBe(0)
        expect(seal?.invalidations).toContain(CaptureInvalidation.Persistence)
        expect(h.chunks).toHaveLength(fault === 'sql-ack-lost' ? 1 : 0)
        expect(h.seals).toHaveLength(fault === 'sql-ack-lost' ? 0 : 1)
        expect((yield* h.recorder.status).retainedReceipts).toBe(0)
        expect((yield* h.recorder.status).retainedPayloadBytes).toBe(researchCaptureExportEnvelopeReservation)
        expect(yield* h.recorder.finish).toEqual(seal)
      }),
    ),
)

test.each(['object-ack-lost', 'object-defect', 'object-interrupt'] as const)(
  '%s in lookahead retains only the acknowledged SQL prefix and leaves native work successful',
  (fault) =>
    run(
      Effect.gen(function* () {
        const h = yield* blockedPipeline(fault)
        yield* Deferred.succeed(h.releaseNextObject, undefined)
        yield* Deferred.succeed(h.releaseSql, undefined)
        const seal = yield* h.recorder.finish
        expect(h.appends).toEqual([0])
        expect(seal?.persistedReceipts).toBe(1)
        expect(seal?.observedReceipts).toBe(2)
        expect(seal?.invalidations).toContain(CaptureInvalidation.Persistence)
        expect((yield* h.recorder.status).retainedReceipts).toBe(0)
        return 'native work remains successful'
      }),
    ).then((result) => expect(result).toBe('native work remains successful')),
)

test('a lookahead deadline includes its wait for preceding SQL and does not reset before its own SQL', () =>
  run(
    Effect.gen(function* () {
      const h = yield* blockedPipeline()
      h.blockSecond()
      yield* Deferred.succeed(h.releaseNextObject, undefined)
      yield* TestClock.adjust(600)
      yield* Deferred.succeed(h.releaseSql, undefined)
      yield* Deferred.await(h.secondSql)
      yield* TestClock.adjust(399)
      expect((yield* h.recorder.status).invalidations).toEqual([])
      yield* TestClock.adjust(1)
      const seal = yield* h.recorder.finish
      expect(h.appends).toEqual([0, 1])
      expect(h.chunks).toHaveLength(1)
      expect(seal?.persistedReceipts).toBe(1)
      expect(seal?.invalidations).toContain(CaptureInvalidation.Persistence)
      expect((yield* h.recorder.status).retainedReceipts).toBe(0)
    }),
  ))

test.each([0, -1])('all three pipeline stages share the exact byte budget with %s bytes slack', (slack) =>
  run(
    Effect.gen(function* () {
      const reservation = (sequence: number) =>
        researchCaptureExportEntryReservation(
          Buffer.byteLength(
            JSON.stringify({
              sequence,
              observedAtMs: 100,
              event: captureEvent(sequence === 1 ? 'STARTED' : 'STOPPED'),
            }),
          ),
          0,
        )
      const budget = researchCaptureExportEnvelopeReservation + reservation(1) + reservation(2) + reservation(3) + slack
      const h = yield* blockedPipeline('none', 32, budget)
      h.recorder.record(captureEvent('STOPPED'), 100)
      const held = yield* h.recorder.status
      expect(held.retainedPayloadBytes).toBeLessThanOrEqual(budget)
      expect(held.retainedReceipts).toBe(slack === 0 ? 3 : 2)
      expect(held.invalidations).toEqual(slack === 0 ? [] : [CaptureInvalidation.Overflow])
      if (slack === 0) expect(held.retainedPayloadBytes).toBe(budget)
      yield* Deferred.succeed(h.releaseSql, undefined)
      yield* Deferred.succeed(h.releaseNextObject, undefined)
      const seal = yield* h.recorder.finish
      expect(seal?.persistedReceipts).toBe(slack === 0 ? 3 : 2)
      expect((yield* h.recorder.status).retainedPayloadBytes).toBe(researchCaptureExportEnvelopeReservation)
    }),
  ),
)

test('a stalled lookahead cancels at its absolute deadline after current SQL has acknowledged', () =>
  run(
    Effect.gen(function* () {
      const h = yield* blockedPipeline()
      yield* Deferred.succeed(h.releaseSql, undefined)
      yield* TestClock.adjust(options.writeTimeoutMs)
      const seal = yield* h.recorder.finish
      expect(h.finalized().nextObjectFinalized).toBe(true)
      expect(h.appends).toEqual([0])
      expect(seal?.persistedReceipts).toBe(1)
      expect(seal?.invalidations).toContain(CaptureInvalidation.Persistence)
      expect((yield* h.recorder.status).retainedReceipts).toBe(0)
      expect((yield* h.recorder.status).retainedPayloadBytes).toBe(researchCaptureExportEnvelopeReservation)
    }),
  ))

test('owner interruption cancels current SQL and lookahead before releasing their reservations', () =>
  run(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<Effect.Success<ReturnType<typeof blockedPipeline>>>()
      const owner = yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* blockedPipeline()
          yield* Deferred.succeed(ready, h)
          return yield* Effect.never
        }),
      ).pipe(Effect.forkChild)
      const h = yield* Deferred.await(ready)
      const cancellation = yield* Fiber.interrupt(owner).pipe(Effect.forkChild)
      yield* TestClock.adjust(options.writeTimeoutMs)
      yield* Fiber.await(cancellation)
      const exit = yield* Fiber.await(owner)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(h.finalized()).toEqual({ firstSqlFinalized: true, nextObjectFinalized: true })
      expect(h.appends).toEqual([0])
      expect((yield* h.recorder.status).retainedReceipts).toBe(0)
      expect((yield* h.recorder.status).retainedPayloadBytes).toBe(researchCaptureExportEnvelopeReservation)
    }),
  ))

test('a backward wall-clock correction cannot extend the monotonic complete-write deadline', () =>
  run(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      let correctionMs = 0
      const corrected: Clock.Clock = {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + correctionMs,
        currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + correctionMs),
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(correctionMs) * 1_000_000n,
        currentTimeNanos: Effect.sync(() => clock.currentTimeNanosUnsafe() + BigInt(correctionMs) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) => clock.sleep(duration),
      }
      const h = yield* blockedPipeline('none', 32, options.maximumQueuedBytes, corrected)
      h.blockSecond()
      yield* Deferred.succeed(h.releaseNextObject, undefined)
      yield* TestClock.adjust(600)
      correctionMs = -10_000
      yield* Deferred.succeed(h.releaseSql, undefined)
      yield* Deferred.await(h.secondSql)
      yield* TestClock.adjust(400)
      const expired = (yield* h.recorder.status).invalidations.includes(CaptureInvalidation.Persistence)
      correctionMs = 0
      yield* Deferred.succeed(h.releaseSecondSql, undefined)
      const seal = yield* h.recorder.finish
      expect(expired).toBe(true)
      expect(seal?.persistedReceipts).toBe(1)
    }),
  ))
