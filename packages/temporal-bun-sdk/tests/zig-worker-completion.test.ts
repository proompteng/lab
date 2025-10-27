process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'

import type { Pointer } from 'bun:ffi'
const { describe, expect, test } = await import('bun:test')
const { TextEncoder } = await import('node:util')
const { temporal } = await import('@temporalio/proto')
const { importNativeBridge } = await import('./helpers/native-bridge')
const { createWorkerTestHelpers } = await import('./helpers/zig-worker')

const { module: nativeBridge, isStub } = await importNativeBridge()
const usingZigBridge = !!nativeBridge && nativeBridge.bridgeVariant === 'zig' && !isStub
const hasWorkflowCompletion =
  usingZigBridge && typeof nativeBridge?.native.workerCompleteWorkflowTask === 'function'

const zigSuite = hasWorkflowCompletion ? describe : describe.skip

zigSuite('zig worker completions', () => {
  if (!nativeBridge) {
    test('zig bridge unavailable', () => {})
    return
  }

  const helpers = createWorkerTestHelpers(nativeBridge.nativeLibraryPath)
  const encoder = new TextEncoder()

  test('workerCompleteWorkflowTask rejects null worker handles with structured error', () => {
    expect.assertions(3)

    try {
      nativeBridge.native.workerCompleteWorkflowTask(
        { type: 'worker', handle: 0 as unknown as Pointer },
        Buffer.from('payload'),
      )
      throw new Error('expected workerCompleteWorkflowTask to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(nativeBridge.NativeBridgeError)
      if (error instanceof nativeBridge.NativeBridgeError) {
        expect(error.code).toBe(3)
        expect(error.message).toBe('temporal-bun-bridge-zig: completeWorkflowTask received null worker handle')
      }
    }
  })

  test('records workflow completion payload via Zig stub', () => {
    expect.assertions(4)

    helpers.install()
    helpers.installCompletionStub()
    helpers.reset()

    const handle = helpers.handle()
    const worker = { type: 'worker' as const, handle }

    const completion = temporal.api.workflowservice.v1.RespondWorkflowTaskCompletedRequest.create({
      taskToken: encoder.encode('unit-test-completion-token'),
      identity: 'temporal-bun-completion-test',
      namespace: 'default',
    })
    const payload = temporal.api.workflowservice.v1.RespondWorkflowTaskCompletedRequest.encode(completion).finish()

    nativeBridge.native.workerCompleteWorkflowTask(worker, payload)

    const recorded = helpers.takeCompletion()
    expect(recorded).not.toBeNull()
    expect(recorded).toBeInstanceOf(Uint8Array)
    const copy = recorded ?? new Uint8Array(0)
    expect(new Uint8Array(copy)).toEqual(payload)
    expect(helpers.completionCount()).toBe(1)
    helpers.reset()
  })
})
