import { describe, expect, mock, test } from 'bun:test'

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

    mock.module('../../src/internal/core-bridge/native.ts', () => {
      class NativeBridgeError extends Error {
        code: number
        details?: unknown

        constructor(input: string | { code?: number; message?: string; details?: unknown }) {
          const message = typeof input === 'string' ? input : input.message ?? 'Native error'
          super(message)
          this.code = typeof input === 'string' ? 0 : input.code ?? 0
          this.details = typeof input === 'string' ? undefined : input.details
          Object.setPrototypeOf(this, new.target.prototype)
        }
      }

      const runtimeHandle = { type: 'runtime' as const, handle: 1 }
      const clientHandle = { type: 'client' as const, handle: 2 }
      const workerHandle = { type: 'worker' as const, handle: 3 }

      return {
        NativeBridgeError,
        native: {
          bridgeVariant: 'zig' as const,
          createRuntime: () => runtimeHandle,
          runtimeShutdown: () => {
            runtimeShutdownCalls += 1
          },
          createClient: async () => clientHandle,
          clientShutdown: () => {
            clientShutdownCalls += 1
          },
          createWorker: () => workerHandle,
          destroyWorker: (worker: typeof workerHandle) => {
            destroyCalls += 1
            worker.handle = 0
            if (!currentDeferred.settled) {
              currentDeferred.reject(new Error('cancelled'))
            }
          },
          workerCompleteWorkflowTask: () => {},
          worker: {
            pollWorkflowTask: async () => {
              pollCalls += 1
              pollReady.resolve()
              currentDeferred = createDeferred<Uint8Array>()
              return await currentDeferred.promise
            },
          },
        },
      }
    })

    mock.module('../../src/config.ts', () => ({
      loadTemporalConfig: async () => ({
        address: '127.0.0.1:7233',
        namespace: 'default',
        taskQueue: 'unit-test-queue',
        workerIdentity: 'unit-test-identity',
        allowInsecureTls: false,
        tls: undefined,
      }),
    }))

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
      mock.restore()
      if (previousFlag === undefined) {
        delete process.env.TEMPORAL_BUN_SDK_USE_ZIG
      } else {
        process.env.TEMPORAL_BUN_SDK_USE_ZIG = previousFlag
      }
    }
  })
})
