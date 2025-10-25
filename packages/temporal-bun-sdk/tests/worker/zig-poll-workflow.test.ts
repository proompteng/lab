process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'

const { afterEach, beforeAll, describe, expect, test } = await import('bun:test')
const { importNativeBridge } = await import('../helpers/native-bridge')
const { createWorkerTestHelpers } = await import('../helpers/zig-worker')
const { TextDecoder } = await import('node:util')

const { module: nativeBridge, isStub } = await importNativeBridge()

const usingZigBridge = Boolean(nativeBridge) && nativeBridge.bridgeVariant === 'zig' && !isStub

if (!usingZigBridge) {
  describe.skip('native.worker.pollWorkflowTask', () => {})
} else {
  const helpers = createWorkerTestHelpers(nativeBridge.nativeLibraryPath)
  const decoder = new TextDecoder()
  const workerApi = nativeBridge.native.worker

  describe('native.worker.pollWorkflowTask', () => {
    beforeAll(() => {
      helpers.install()
      helpers.reset()
    })

    afterEach(() => {
      helpers.reset()
    })

    test('resolves workflow activations consistently', async () => {
      helpers.setMode('success')

      const handle = helpers.handle()
      const worker = { type: 'worker' as const, handle }

      const first = await workerApi.pollWorkflowTask(worker)
      const second = await workerApi.pollWorkflowTask(worker)

      expect(decoder.decode(first)).toBe('stub-activation')
      expect(decoder.decode(second)).toBe('stub-activation')
      expect(first).not.toBe(second)
    })

    test('rejects with NativeBridgeError when poll fails', async () => {
      helpers.setMode('failure')

      const handle = helpers.handle()
      const worker = { type: 'worker' as const, handle }

      await expect(workerApi.pollWorkflowTask(worker)).rejects.toMatchObject({
        code: 13,
        message: 'stub-poll-failure',
      })
    })

    test('rejects with cancelled error when worker shuts down', async () => {
      helpers.setMode('shutdown')

      const handle = helpers.handle()
      const worker = { type: 'worker' as const, handle }

      await expect(workerApi.pollWorkflowTask(worker)).rejects.toMatchObject({
        code: 1,
        message: expect.stringContaining('workflow task poll cancelled'),
      })
    })
  })
}
