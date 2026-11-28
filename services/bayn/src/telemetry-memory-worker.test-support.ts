import { parentPort } from 'node:worker_threads'
import { NodeRuntime } from '@effect/platform-node'
import { Effect, Metric } from 'effect'
import { PrometheusMetrics } from 'effect/observability'
import { recordProcessMemory, sampleRuntimeMemory } from './telemetry-memory'

if (parentPort === null) throw new Error('Memory fixture requires a worker port')
const port = parentPort
NodeRuntime.runMain(
  Effect.gen(function* () {
    yield* recordProcessMemory
    const sample = yield* sampleRuntimeMemory
    const metrics = yield* PrometheusMetrics.format()
    port.postMessage({ sample, metrics })
  }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
)
