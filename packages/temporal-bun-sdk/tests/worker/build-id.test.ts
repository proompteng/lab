import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

describe('createWorker buildId plumbing', () => {
  test('passes a derived buildId to native.createWorker', async () => {
    const previousEnv = {
      TEMPORAL_BUN_SDK_USE_ZIG: process.env.TEMPORAL_BUN_SDK_USE_ZIG,
      TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS,
      TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE,
      TEMPORAL_TASK_QUEUE: process.env.TEMPORAL_TASK_QUEUE,
      TEMPORAL_ALLOW_INSECURE: process.env.TEMPORAL_ALLOW_INSECURE,
      TEMPORAL_WORKER_BUILD_ID: process.env.TEMPORAL_WORKER_BUILD_ID,
    }

    process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'
    process.env.TEMPORAL_ADDRESS = '127.0.0.1:7233'
    process.env.TEMPORAL_NAMESPACE = 'default'
    process.env.TEMPORAL_TASK_QUEUE = 'unit-test-queue'
    process.env.TEMPORAL_ALLOW_INSECURE = '0'
    delete process.env.TEMPORAL_WORKER_BUILD_ID

    const nativeModule = await import('../../src/internal/core-bridge/native.ts')
    const originalNative = {
      createRuntime: nativeModule.native.createRuntime,
      createClient: nativeModule.native.createClient,
      createWorker: nativeModule.native.createWorker,
      destroyWorker: nativeModule.native.destroyWorker,
      clientShutdown: nativeModule.native.clientShutdown,
      runtimeShutdown: nativeModule.native.runtimeShutdown,
      workerPollWorkflowTask: nativeModule.native.worker.pollWorkflowTask,
      workerPollActivityTask: nativeModule.native.worker.pollActivityTask,
      workerInitiateShutdown: nativeModule.native.worker.initiateShutdown,
      workerFinalizeShutdown: nativeModule.native.worker.finalizeShutdown,
    } as const

    const runtimeHandle = { type: 'runtime' as const, handle: 1 }
    const clientHandle = { type: 'client' as const, handle: 2 }
    const workerHandle = { type: 'worker' as const, handle: 3 }

    let capturedConfig: Record<string, unknown> | null = null

    nativeModule.native.createRuntime = () => runtimeHandle
    nativeModule.native.createClient = async () => clientHandle
    nativeModule.native.createWorker = (_runtime, _client, config) => {
      capturedConfig = config
      return workerHandle
    }
    nativeModule.native.destroyWorker = () => {}
    nativeModule.native.clientShutdown = () => {}
    nativeModule.native.runtimeShutdown = () => {}
    nativeModule.native.worker.pollWorkflowTask = async () => new Uint8Array(0)
    nativeModule.native.worker.pollActivityTask = async () => new Uint8Array(0)
    nativeModule.native.worker.initiateShutdown = () => {}
    nativeModule.native.worker.finalizeShutdown = () => {}

    try {
      const pkgUrl = new URL('../../package.json', import.meta.url)
      const pkg = JSON.parse(await Bun.file(pkgUrl).text()) as { name?: string; version?: string }
      const expectedBuildId = `${pkg.name}@${pkg.version}`

      const { createWorker } = await import('../../src/worker.ts?build-id-test')
      const workflowsUrl = new URL('../fixtures/workflows/simple.workflow.ts', import.meta.url)
      const resolvedWorkflowsPath = fileURLToPath(workflowsUrl)

      const handle = await createWorker({ taskQueue: 'unit-test-queue', workflowsPath: resolvedWorkflowsPath })

      expect(capturedConfig).not.toBeNull()
      expect(typeof capturedConfig?.buildId).toBe('string')
      expect((capturedConfig?.buildId as string | undefined)?.length).toBeGreaterThan(0)
      expect(capturedConfig?.buildId).toBe(expectedBuildId)

      await handle.runtime.shutdown()
    } finally {
      nativeModule.native.createRuntime = originalNative.createRuntime
      nativeModule.native.createClient = originalNative.createClient
      nativeModule.native.createWorker = originalNative.createWorker
      nativeModule.native.destroyWorker = originalNative.destroyWorker
      nativeModule.native.clientShutdown = originalNative.clientShutdown
      nativeModule.native.runtimeShutdown = originalNative.runtimeShutdown
      nativeModule.native.worker.pollWorkflowTask = originalNative.workerPollWorkflowTask
      nativeModule.native.worker.pollActivityTask = originalNative.workerPollActivityTask
      nativeModule.native.worker.initiateShutdown = originalNative.workerInitiateShutdown
      nativeModule.native.worker.finalizeShutdown = originalNative.workerFinalizeShutdown

      if (previousEnv.TEMPORAL_BUN_SDK_USE_ZIG === undefined) {
        delete process.env.TEMPORAL_BUN_SDK_USE_ZIG
      } else {
        process.env.TEMPORAL_BUN_SDK_USE_ZIG = previousEnv.TEMPORAL_BUN_SDK_USE_ZIG
      }

      process.env.TEMPORAL_ADDRESS = previousEnv.TEMPORAL_ADDRESS
      process.env.TEMPORAL_NAMESPACE = previousEnv.TEMPORAL_NAMESPACE
      process.env.TEMPORAL_TASK_QUEUE = previousEnv.TEMPORAL_TASK_QUEUE
      if (previousEnv.TEMPORAL_ALLOW_INSECURE === undefined) {
        delete process.env.TEMPORAL_ALLOW_INSECURE
      } else {
        process.env.TEMPORAL_ALLOW_INSECURE = previousEnv.TEMPORAL_ALLOW_INSECURE
      }
      if (previousEnv.TEMPORAL_WORKER_BUILD_ID === undefined) {
        delete process.env.TEMPORAL_WORKER_BUILD_ID
      } else {
        process.env.TEMPORAL_WORKER_BUILD_ID = previousEnv.TEMPORAL_WORKER_BUILD_ID
      }
    }
  })
})
