import { describe, expect, mock, spyOn, test } from 'bun:test'
import { createRuntime } from '../src/core-bridge/runtime.ts'
import { createClient } from '../src/core-bridge/client.ts'
import { createWorker } from '../src/core-bridge/worker.ts'
import * as nativeModule from '../src/internal/core-bridge/native.ts'

const runtimeHandle = { type: 'runtime', handle: 10 } as const
const clientHandle = { type: 'client', handle: 20 } as const
const workerHandle = { type: 'worker', handle: 30 } as const

describe('core-bridge worker', () => {
  test('wires options into native worker lifecycle', async () => {
    const createRuntimeSpy = spyOn(nativeModule.native, 'createRuntime').mockReturnValue(runtimeHandle)
    const runtimeShutdown = mock(() => {})
    const runtimeShutdownSpy = spyOn(nativeModule.native, 'runtimeShutdown').mockImplementation(runtimeShutdown)

    const createClientSpy = spyOn(nativeModule.native, 'createClient').mockResolvedValue(clientHandle)
    const clientShutdown = mock(() => {})
    const clientShutdownSpy = spyOn(nativeModule.native, 'clientShutdown').mockImplementation(clientShutdown)

    const createWorkerSpy = spyOn(nativeModule.native, 'createWorker').mockReturnValue(workerHandle)
    const workerValidateSpy = spyOn(nativeModule.native, 'workerValidate').mockResolvedValue(undefined)
    const workerShutdownSpy = spyOn(nativeModule.native, 'workerShutdown').mockResolvedValue(undefined)
    const workerInitiateShutdownSpy = spyOn(nativeModule.native, 'workerInitiateShutdown').mockImplementation(() => {})
    const workerFreeSpy = spyOn(nativeModule.native, 'workerFree').mockImplementation(() => {})

    try {
      const runtime = createRuntime()
      const client = await createClient(runtime, {
        address: '127.0.0.1:7233',
        namespace: 'default',
      })

      const worker = await createWorker(runtime, client, {
        namespace: 'default',
        taskQueue: 'prix',
        identity: 'worker-1',
        buildId: 'build-123',
        maxCachedWorkflows: 5,
        noRemoteActivities: true,
      })

      expect(createWorkerSpy).toHaveBeenCalledTimes(1)
      const [, , payload] = createWorkerSpy.mock.calls[0]
      expect(payload).toEqual({
        namespace: 'default',
        task_queue: 'prix',
        identity: 'worker-1',
        build_id: 'build-123',
        max_cached_workflows: 5,
        no_remote_activities: true,
      })

      await worker.validate()
      expect(workerValidateSpy).toHaveBeenCalledWith(workerHandle)

      worker.initiateShutdown()
      expect(workerInitiateShutdownSpy).toHaveBeenCalledWith(workerHandle)

      await worker.shutdown()
      expect(workerShutdownSpy).toHaveBeenCalledWith(workerHandle)
      expect(workerFreeSpy).toHaveBeenCalledWith(workerHandle)

      await client.shutdown()
      await runtime.shutdown()

      expect(clientShutdownSpy).toHaveBeenCalledWith(clientHandle)
      expect(runtimeShutdownSpy).toHaveBeenCalledWith(runtimeHandle)
    } finally {
      createWorkerSpy.mockRestore()
      workerValidateSpy.mockRestore()
      workerShutdownSpy.mockRestore()
      workerInitiateShutdownSpy.mockRestore()
      workerFreeSpy.mockRestore()
      createClientSpy.mockRestore()
      clientShutdownSpy.mockRestore()
      createRuntimeSpy.mockRestore()
      runtimeShutdownSpy.mockRestore()
    }
  })
})
