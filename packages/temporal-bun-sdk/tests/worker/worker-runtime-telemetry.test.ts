import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

const serializeEnv = (keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, process.env[key as keyof NodeJS.ProcessEnv] ?? undefined]))

describe('WorkerRuntime telemetry configuration', () => {
  test('configures telemetry before creating the native client', async () => {
    const previousFlag = process.env.TEMPORAL_BUN_SDK_USE_ZIG
    process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'

    const envKeys = [
      'TEMPORAL_ADDRESS',
      'TEMPORAL_NAMESPACE',
      'TEMPORAL_TASK_QUEUE',
      'TEMPORAL_ALLOW_INSECURE',
      'TEMPORAL_METRICS_EXPORTER',
      'TEMPORAL_PROMETHEUS_ENDPOINT',
      'TEMPORAL_LOG_FILTER',
      'TEMPORAL_METRICS_PREFIX',
      'TEMPORAL_METRICS_ATTACH_SERVICE_NAME',
      'TEMPORAL_METRICS_GLOBAL_TAGS',
    ]
    const previousEnv = serializeEnv(envKeys)

    process.env.TEMPORAL_ADDRESS = '127.0.0.1:7233'
    process.env.TEMPORAL_NAMESPACE = 'default'
    process.env.TEMPORAL_TASK_QUEUE = 'unit-test-queue'
    process.env.TEMPORAL_ALLOW_INSECURE = '0'
    process.env.TEMPORAL_METRICS_EXPORTER = 'prometheus'
    process.env.TEMPORAL_PROMETHEUS_ENDPOINT = '127.0.0.1:9464'
    process.env.TEMPORAL_LOG_FILTER = 'debug'
    process.env.TEMPORAL_METRICS_PREFIX = 'bun-worker'
    process.env.TEMPORAL_METRICS_ATTACH_SERVICE_NAME = 'true'
    process.env.TEMPORAL_METRICS_GLOBAL_TAGS = '{"service":"worker"}'

  const nativeModule = await import('../../src/internal/core-bridge/native')
    const originalNative = {
      createRuntime: nativeModule.native.createRuntime,
      configureTelemetry: nativeModule.native.configureTelemetry,
      createClient: nativeModule.native.createClient,
      clientShutdown: nativeModule.native.clientShutdown,
      runtimeShutdown: nativeModule.native.runtimeShutdown,
      createWorker: nativeModule.native.createWorker,
      destroyWorker: nativeModule.native.destroyWorker,
      workerInitiateShutdown: nativeModule.native.worker.initiateShutdown,
      workerFinalizeShutdown: nativeModule.native.worker.finalizeShutdown,
    } as const

  const runtimeHandle = { type: 'runtime' as const, handle: 11 } as any
  const clientHandle = { type: 'client' as const, handle: 12 } as any
  const workerHandle = { type: 'worker' as const, handle: 13 } as any
    const telemetryCalls: Array<Record<string, unknown>> = []

    nativeModule.native.createRuntime = () => runtimeHandle
    nativeModule.native.configureTelemetry = (runtime, options) => {
  expect(runtime).toBe(runtimeHandle as any)
      telemetryCalls.push(options ?? {})
    }
    nativeModule.native.createClient = async () => clientHandle
    nativeModule.native.clientShutdown = () => {}
    nativeModule.native.runtimeShutdown = () => {}
    nativeModule.native.createWorker = () => workerHandle
    nativeModule.native.destroyWorker = () => {}
    nativeModule.native.worker.initiateShutdown = () => {}
    nativeModule.native.worker.finalizeShutdown = () => {}

    try {
  // @ts-expect-error Allow importing TypeScript module with query param for isolation
  const { WorkerRuntime } = await import('../../src/worker/runtime.ts?telemetry-test')
      const workflowsUrl = new URL('../fixtures/workflows/simple.workflow.ts', import.meta.url)
      const runtime = await WorkerRuntime.create({
        workflowsPath: fileURLToPath(workflowsUrl),
        taskQueue: 'unit-test-queue',
        buildId: 'telemetry-test',
      })

      expect(telemetryCalls).toHaveLength(1)
      expect(telemetryCalls[0]).toEqual({
        logExporter: { filter: 'debug' },
        telemetry: { metricPrefix: 'bun-worker', attachServiceName: true },
        metricsExporter: {
          type: 'prometheus',
          socketAddr: '127.0.0.1:9464',
          globalTags: { service: 'worker' },
        },
      })

      await runtime.shutdown()
    } finally {
      nativeModule.native.createRuntime = originalNative.createRuntime
      nativeModule.native.configureTelemetry = originalNative.configureTelemetry
      nativeModule.native.createClient = originalNative.createClient
      nativeModule.native.clientShutdown = originalNative.clientShutdown
      nativeModule.native.runtimeShutdown = originalNative.runtimeShutdown
      nativeModule.native.createWorker = originalNative.createWorker
      nativeModule.native.destroyWorker = originalNative.destroyWorker
      nativeModule.native.worker.initiateShutdown = originalNative.workerInitiateShutdown
      nativeModule.native.worker.finalizeShutdown = originalNative.workerFinalizeShutdown

      for (const key of envKeys) {
        const previous = previousEnv[key]
        if (previous === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = previous
        }
      }

      if (previousFlag === undefined) {
        delete process.env.TEMPORAL_BUN_SDK_USE_ZIG
      } else {
        process.env.TEMPORAL_BUN_SDK_USE_ZIG = previousFlag
      }
    }
  })
})
