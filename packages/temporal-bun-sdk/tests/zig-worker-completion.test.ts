process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'

import type { Pointer } from 'bun:ffi'
const { describe, expect, test } = await import('bun:test')
const { importNativeBridge } = await import('./helpers/native-bridge')

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
})
