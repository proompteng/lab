import { describe, expect, test } from 'bun:test'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
  readonly settled: boolean
}

function createDeferred<T>(): Deferred<T> {
  let settleResolve: (value: T) => void
  let settleReject: (reason?: unknown) => void
  let isSettled = false

  const promise = new Promise<T>((resolve, reject) => {
    settleResolve = (value: T) => {
      if (isSettled) return
      isSettled = true
      resolve(value)
    }
    settleReject = (reason?: unknown) => {
      if (isSettled) return
      isSettled = true
      reject(reason)
    }
  })

  return {
    promise,
    resolve: (value: T) => settleResolve(value),
    reject: (reason?: unknown) => settleReject(reason),
    get settled() {
      return isSettled
    },
  }
}

describe('WorkerRuntime.shutdown', () => {
  test('destroys the native worker to cancel in-flight polls', async () => {
    const previousFlag = process.env.TEMPORAL_BUN_SDK_USE_ZIG
    process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'

    const pollReady = createDeferred<void>()
    let currentDeferred = createDeferred<Uint8Array>()
    let destroyCalls = 0
    let runtimeShutdownCalls = 0
    let clientShutdownCalls = 0
    let pollCalls = 0

    const nativeModule = await import('../../src/internal/core-bridge/native.ts')
    const originalNative = {
      createRuntime: nativeModule.native.createRuntime,
      runtimeShutdown: nativeModule.native.runtimeShutdown,
      createClient: nativeModule.native.createClient,
      clientShutdown: nativeModule.native.clientShutdown,
      createWorker: nativeModule.native.createWorker,
      destroyWorker: nativeModule.native.destroyWorker,
      workerCompleteWorkflowTask: nativeModule.native.workerCompleteWorkflowTask,
      workerPollWorkflowTask: nativeModule.native.worker.pollWorkflowTask,
    } as const

    const runtimeHandle = { type: 'runtime' as const, handle: 1 }
    const clientHandle = { type: 'client' as const, handle: 2 }
    const workerHandle = { type: 'worker' as const, handle: 3 }

    nativeModule.native.createRuntime = () => runtimeHandle
    nativeModule.native.runtimeShutdown = () => {
      runtimeShutdownCalls += 1
    }
    nativeModule.native.createClient = async () => clientHandle
    nativeModule.native.clientShutdown = () => {
      clientShutdownCalls += 1
    }
    nativeModule.native.createWorker = () => workerHandle
    nativeModule.native.destroyWorker = (worker: typeof workerHandle) => {
      destroyCalls += 1
      worker.handle = 0
      if (!currentDeferred.settled) {
        currentDeferred.reject(new Error('cancelled'))
      }
    }
    nativeModule.native.workerCompleteWorkflowTask = () => {}
    nativeModule.native.worker.pollWorkflowTask = async () => {
      pollCalls += 1
      pollReady.resolve()
      currentDeferred = createDeferred<Uint8Array>()
      return await currentDeferred.promise
    }

    const previousEnv = {
      TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS,
      TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE,
      TEMPORAL_TASK_QUEUE: process.env.TEMPORAL_TASK_QUEUE,
      TEMPORAL_ALLOW_INSECURE: process.env.TEMPORAL_ALLOW_INSECURE,
    }
    process.env.TEMPORAL_ADDRESS = '127.0.0.1:7233'
    process.env.TEMPORAL_NAMESPACE = 'default'
    process.env.TEMPORAL_TASK_QUEUE = 'unit-test-queue'
    process.env.TEMPORAL_ALLOW_INSECURE = '0'

    try {
      const { WorkerRuntime } = await import('../../src/worker/runtime.ts?shutdown-test')
      const runtime = await WorkerRuntime.create({
        workflowsPath: '/tmp/workflows',
        taskQueue: 'unit-test-queue',
      })

      const runPromise = runtime.run()
      await pollReady.promise

      await runtime.shutdown()
      await runPromise

      expect(pollCalls).toBeGreaterThanOrEqual(1)
      expect(destroyCalls).toBeGreaterThan(0)
      expect(runtimeShutdownCalls).toBe(1)
      expect(clientShutdownCalls).toBe(1)
    } finally {
      nativeModule.native.createRuntime = originalNative.createRuntime
      nativeModule.native.runtimeShutdown = originalNative.runtimeShutdown
      nativeModule.native.createClient = originalNative.createClient
      nativeModule.native.clientShutdown = originalNative.clientShutdown
      nativeModule.native.createWorker = originalNative.createWorker
      nativeModule.native.destroyWorker = originalNative.destroyWorker
      nativeModule.native.workerCompleteWorkflowTask = originalNative.workerCompleteWorkflowTask
      nativeModule.native.worker.pollWorkflowTask = originalNative.workerPollWorkflowTask
      process.env.TEMPORAL_ADDRESS = previousEnv.TEMPORAL_ADDRESS
      process.env.TEMPORAL_NAMESPACE = previousEnv.TEMPORAL_NAMESPACE
      process.env.TEMPORAL_TASK_QUEUE = previousEnv.TEMPORAL_TASK_QUEUE
      if (previousEnv.TEMPORAL_ALLOW_INSECURE === undefined) {
        delete process.env.TEMPORAL_ALLOW_INSECURE
      } else {
        process.env.TEMPORAL_ALLOW_INSECURE = previousEnv.TEMPORAL_ALLOW_INSECURE
      }

      if (previousFlag === undefined) {
        delete process.env.TEMPORAL_BUN_SDK_USE_ZIG
      } else {
        process.env.TEMPORAL_BUN_SDK_USE_ZIG = previousFlag
      }
    }
  })
})
