process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'

const { beforeAll, describe, expect, test } = await import('bun:test')
const { importNativeBridge } = await import('../helpers/native-bridge')
const { createWorkerTestHelpers } = await import('../helpers/zig-worker')
const { TextDecoder, TextEncoder } = await import('node:util')

const { temporal } = await import('@temporalio/proto')
const { module: nativeBridge, isStub } = await importNativeBridge()

const usingZigBridge = Boolean(nativeBridge) && nativeBridge.bridgeVariant === 'zig' && !isStub
const hasWorkflowPolling =
  usingZigBridge && typeof nativeBridge?.native.worker?.pollWorkflowTask === 'function'

if (!hasWorkflowPolling) {
  describe.skip('native.worker.pollWorkflowTask', () => {})
} else {
  const helpers = createWorkerTestHelpers(nativeBridge.nativeLibraryPath)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const workerApi = nativeBridge.native.worker

  describe('native.worker.pollWorkflowTask', () => {
    beforeAll(() => {
      helpers.install()
      helpers.reset()
    })

    test('resolves workflow activations consistently', async () => {
      helpers.reset()
      helpers.setMode('success')

      const activation = temporal.api.workflowservice.v1.PollWorkflowTaskQueueResponse.create({
        taskToken: encoder.encode('unit-test-task-token'),
        workflowExecution: {
          workflowId: 'zig-worker-e2e',
          runId: '00000000-0000-0000-0000-000000000001',
        },
      })
      const activationBytes = temporal.api.workflowservice.v1.PollWorkflowTaskQueueResponse.encode(activation).finish()
      helpers.setWorkflowActivationPayload(activationBytes)

      const handle = helpers.handle()
      const worker = { type: 'worker' as const, handle }

      const first = await workerApi.pollWorkflowTask(worker)
      const second = await workerApi.pollWorkflowTask(worker)

      expect(first).not.toBe(second)
      expect(new Uint8Array(first)).toEqual(activationBytes)
      expect(new Uint8Array(second)).toEqual(activationBytes)

      const decoded = temporal.api.workflowservice.v1.PollWorkflowTaskQueueResponse.decode(first)
      expect(decoder.decode(decoded.taskToken)).toBe('unit-test-task-token')
      helpers.reset()
    })
  })
}
