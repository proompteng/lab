import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../effect-test-support'
import { sha256 } from '../hash'
import { captureKafkaTransport } from './capture'
import { captureEvent, marketEvent } from './capture.test-support'
import { makeResearchCaptureRecorder } from './recorder'
import { sessionMemory } from './session.test-support'

// Reproduce the existing budget-test burst, adding deterministic persistence latency.
// This is an assumed synthetic arrival envelope, never a production throughput measurement.
export const runCaptureLatencyEnvelope = (
  objectDelayMs: number,
  sqlDelayMs: number,
  burst = { receipts: 4439, durationMs: 50 },
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const saved = sessionMemory()
        const recorder = yield* makeResearchCaptureRecorder(
          {
            append: (bytes) => Effect.sleep(sqlDelayMs).pipe(Effect.andThen(saved.store.append(bytes))),
            seal: (bytes) => Effect.sleep(sqlDelayMs).pipe(Effect.andThen(saved.store.seal(bytes))),
          },
          {
            captureId: 'synthetic-latency-envelope',
            sourceRevision: 'a'.repeat(40),
            maximumQueuedReceipts: 1024,
            maximumQueuedBytes: 4 * 1024 * 1024,
            maximumReceiptBytes: 64 * 1024,
            flushIntervalMs: 50,
            writeTimeoutMs: 1000,
            maximumObjectBytes: 8 * 1024 * 1024,
            maximumSqlBytes: 4 * 1024 * 1024,
          },
          {
            putVerified: (object) =>
              Effect.sleep(objectDelayMs).pipe(Effect.andThen(saved.objectStore.putVerified(object))),
          },
        )
        const raw = Buffer.alloc(450, 120)
        const rawValueSha256 = sha256(raw)
        let now = 0
        let maximumRetainedReceipts = 0
        let maximumRetainedBytes = 0
        let firstInvalidationAtMs: number | null = null
        let firstInvalidationAtReceipt: number | null = null
        recorder.record(captureEvent('STARTED'))
        yield* TestClock.adjust(50 + objectDelayMs + sqlDelayMs)
        for (let sequence = 1; sequence <= burst.receipts; sequence++) {
          const atMs = Math.floor(((sequence - 1) * burst.durationMs) / burst.receipts)
          if (atMs > now) {
            yield* TestClock.adjust(atMs - now)
            now = atMs
          }
          if (sequence % 256 === 0) yield* Effect.yieldNow
          recorder.record(
            {
              ...marketEvent,
              consumerSequence: sequence,
              projectionSequence: sequence,
              offset: String(sequence),
              originalTransport: captureKafkaTransport(atMs),
              rawByteLength: raw.byteLength,
              rawValueSha256,
            },
            undefined,
            raw,
          )
          const status = yield* recorder.status
          maximumRetainedReceipts = Math.max(maximumRetainedReceipts, status.retainedReceipts)
          maximumRetainedBytes = Math.max(maximumRetainedBytes, status.retainedPayloadBytes)
          if (status.invalidations.length !== 0 && firstInvalidationAtMs === null) {
            firstInvalidationAtMs = atMs
            firstInvalidationAtReceipt = sequence
          }
        }
        const finishing = yield* recorder.finish.pipe(Effect.forkChild)
        yield* TestClock.adjust(3000)
        const seal = yield* Fiber.join(finishing)
        const status = yield* recorder.status
        return {
          evidenceKind: 'SYNTHETIC_CONSTANT_LATENCY' as const,
          objectDelayMs,
          sqlDelayMs,
          marketReceipts: burst.receipts,
          burstDurationMs: burst.durationMs,
          rawBytesPerReceipt: raw.byteLength,
          firstInvalidationAtMs,
          firstInvalidationAtReceipt,
          maximumRetainedReceipts,
          maximumRetainedBytes,
          observedReceipts: status.observedReceipts,
          persistedReceipts: status.persistedReceipts,
          invalidations: status.invalidations,
          retainedAfterFinish: status.retainedReceipts,
          attemptedObjectBytes: status.attemptedObjectBytes,
          attemptedSqlBytes: status.attemptedSqlBytes,
          objectWrites: saved.objects.length,
          sqlAppends: saved.chunks.length,
          sqlSeals: saved.seals.length,
          qualification: seal?.qualification ?? null,
        }
      }),
    ).pipe(provideTestLayer(TestClock.layer())),
  )
