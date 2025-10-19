import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

process.env.TEMPORAL_BUN_SDK_USE_ZIG = process.env.TEMPORAL_BUN_SDK_USE_ZIG ?? '1'

const nativeModule = await import('../../src/internal/core-bridge/native.ts')
const { native, isZigBridge, NativeBridgeError } = nativeModule
const { WorkerRuntime } = await import('../../src/worker/runtime.ts')

type ActivityCompletionPayload = nativeModule.ActivityCompletionPayload

type ActivityCompletionKind = 'completed' | 'failed'

const workerSuite = isZigBridge ? describe : describe.skip

const textEncoder = new TextEncoder()

const recordedHandles: number[] = []

function activityBytes(label: string): Uint8Array {
  return textEncoder.encode(label)
}

function createHandle(corePointer: number): number {
  const handle = native.worker.testing.createWorkerHandle(corePointer)
  recordedHandles.push(handle)
  return handle
}

function resetTestingState(): void {
  native.worker.testing.resetActivityCompletions()
  native.worker.testing.setActivityCompletionStatus('completed', 0)
  native.worker.testing.setActivityCompletionStatus('failed', 0)
}

function assertUint8ArrayEqual(actual: Uint8Array | null, expected: Uint8Array): void {
  expect(actual).not.toBeNull()
  expect(actual).toEqual(expected)
}

workerSuite('native worker activity completion', () => {
  beforeEach(() => {
    resetTestingState()
  })

  afterEach(() => {
    while (recordedHandles.length > 0) {
      const handle = recordedHandles.pop()
      if (handle !== undefined) {
        native.worker.free(handle)
      }
    }
    resetTestingState()
  })

  test('completeActivityTask sends completed payload through Zig bridge', () => {
    const handle = createHandle(0x4444)
    const taskToken = new Uint8Array([0x01, 0x02, 0x03])
    const completion: ActivityCompletionPayload = {
      status: 'completed',
      taskToken,
      result: activityBytes('success'),
    }

    native.worker.completeActivityTask(handle, completion)

    assertUint8ArrayEqual(native.worker.testing.takeActivityTaskToken('completed'), taskToken)
    assertUint8ArrayEqual(native.worker.testing.takeActivityPayload('completed'), activityBytes('success'))
    expect(native.worker.testing.lastActivityWorker('completed')).toBe(0x4444)
    expect(native.worker.testing.takeActivityTaskToken('failed')).toBeNull()
  })

  test('completeActivityTask sends failure payload through Zig bridge', () => {
    const handle = createHandle(0x5555)
    const taskToken = new Uint8Array([0x09, 0x08, 0x07])
    const completion: ActivityCompletionPayload = {
      status: 'failed',
      taskToken,
      failure: activityBytes('failure'),
    }

    native.worker.completeActivityTask(handle, completion)

    assertUint8ArrayEqual(native.worker.testing.takeActivityTaskToken('failed'), taskToken)
    assertUint8ArrayEqual(native.worker.testing.takeActivityPayload('failed'), activityBytes('failure'))
    expect(native.worker.testing.lastActivityWorker('failed')).toBe(0x5555)
    expect(native.worker.testing.takeActivityTaskToken('completed')).toBeNull()
  })

  test('completeActivityTask rejects failed activity without failure payload', () => {
    const handle = createHandle(0x6666)
    const completion: ActivityCompletionPayload = {
      status: 'failed',
      taskToken: new Uint8Array([0xaa]),
    }

    expect(() => native.worker.completeActivityTask(handle, completion)).toThrow(NativeBridgeError)
    expect(native.worker.testing.takeActivityTaskToken('failed')).toBeNull()
  })

  test('WorkerRuntime completes activity through Zig helper', () => {
    const handle = createHandle(0x7777)
    const taskToken = new Uint8Array([0xde, 0xad])
    const completion: ActivityCompletionPayload = {
      status: 'completed',
      taskToken,
      result: activityBytes('runtime'),
    }

    const completeNative = WorkerRuntime['completeActivityTaskNative'] as (
      workerHandle: number,
      payload: ActivityCompletionPayload,
    ) => void

    completeNative(handle, completion)

    assertUint8ArrayEqual(native.worker.testing.takeActivityTaskToken('completed'), taskToken)
    assertUint8ArrayEqual(native.worker.testing.takeActivityPayload('completed'), activityBytes('runtime'))
  })
})
