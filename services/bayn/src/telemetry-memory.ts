import { memoryUsage } from 'node:process'
import { getHeapStatistics } from 'node:v8'
import { isMainThread } from 'node:worker_threads'
import { Clock, Effect, Metric, Result, Schema } from 'effect'

export enum RuntimeIsolate {
  Main = 'main',
  MarketProjection = 'market-projection',
  DecisionConstruction = 'decision-construction',
}

const bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const RuntimeMemorySampleSchema = Schema.Struct({
  observedAtSeconds: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  heapUsed: bytes,
  heapTotal: bytes,
  external: bytes,
  arrayBuffers: bytes,
  heapLimit: bytes,
})
export type RuntimeMemorySample = typeof RuntimeMemorySampleSchema.Type
const decodeRuntimeMemorySample = Schema.decodeUnknownResult(RuntimeMemorySampleSchema)

// Node's RSS is process-wide; the other fields belong to the calling worker's isolate.
export const sampleRuntimeMemory = Effect.gen(function* () {
  const observedAtSeconds = (yield* Clock.currentTimeMillis) / 1000
  return yield* Effect.sync(() => {
    const { heapUsed, heapTotal, external, arrayBuffers } = memoryUsage()
    return {
      observedAtSeconds,
      heapUsed,
      heapTotal,
      external,
      arrayBuffers,
      heapLimit: getHeapStatistics().heap_size_limit,
    }
  })
}).pipe(
  Effect.catchDefect(() => Effect.void),
  Effect.map((sample) => sample ?? undefined),
)

const usage = Metric.gauge('bayn_runtime_memory_bytes', {
  description:
    'Last sampled isolate memory by kind; array_buffers is included in external, and heap_used in heap_total.',
})
const observed = Metric.gauge('bayn_runtime_memory_sample_timestamp_seconds', {
  description: 'Original isolate sample time; zero means the worker or its last diagnostic sample is unavailable.',
})
const resident = Metric.gauge('bayn_runtime_process_resident_memory_bytes', {
  description: 'Process-wide RSS, sampled only by the parent; includes all worker isolates and native allocations.',
})

export const recordRuntimeMemory = (isolate: RuntimeIsolate, sample: RuntimeMemorySample | undefined) =>
  Effect.gen(function* () {
    for (const [kind, value] of [
      ['heap_used', sample?.heapUsed ?? 0],
      ['heap_total', sample?.heapTotal ?? 0],
      ['external', sample?.external ?? 0],
      ['array_buffers', sample?.arrayBuffers ?? 0],
      ['heap_limit', sample?.heapLimit ?? 0],
    ] as const)
      yield* Metric.update(usage.pipe(Metric.withAttributes({ isolate, kind })), value)
    yield* Metric.update(observed.pipe(Metric.withAttributes({ isolate })), sample?.observedAtSeconds ?? 0)
  }).pipe(Effect.catchDefect(() => Effect.logWarning('Bayn isolate memory diagnostic could not be recorded')))

export const recordProcessMemory = Effect.gen(function* () {
  if (!isMainThread) return
  yield* recordRuntimeMemory(RuntimeIsolate.Main, yield* sampleRuntimeMemory)
  yield* Metric.update(resident, yield* Effect.sync(() => memoryUsage.rss()))
}).pipe(Effect.catchDefect(() => Effect.logWarning('Bayn process memory diagnostic could not be recorded')))

/** The parent exports existing bounded worker frames; workers acquire no extra exporter or polling request. */
export const observeWorkerMemory = (isolate: RuntimeIsolate.MarketProjection | RuntimeIsolate.DecisionConstruction) =>
  Effect.gen(function* () {
    let latest: RuntimeMemorySample | undefined
    const record = Effect.suspend(() => recordRuntimeMemory(isolate, latest))
    yield* Effect.addFinalizer(() => {
      latest = undefined
      return record
    })
    yield* record
    yield* Effect.forever(Effect.sleep('15 seconds').pipe(Effect.andThen(record))).pipe(Effect.forkScoped)
    return {
      receive: (value: unknown) => {
        const decoded = decodeRuntimeMemorySample(value)
        latest = Result.isSuccess(decoded) ? decoded.success : undefined
      },
      clear: () => {
        latest = undefined
      },
      record,
    }
  })
