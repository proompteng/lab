import { beforeEach, describe, expect, test } from 'bun:test'
import { importNativeBridge } from '../helpers/native-bridge'

const originalEnvUseZig = process.env.TEMPORAL_BUN_SDK_USE_ZIG
const { module: nativeBridge, isStub } = await importNativeBridge()

if (!nativeBridge || isStub) {
  describe.skip('native worker activity polling (Zig bridge)', () => {
    test('native bridge unavailable', () => {})
  })
} else {
  process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'

  const { native, NativeBridgeError, __testing } = nativeBridge
  const originalWorkerPoll = __testing.workerFfi.pollActivityTask
  const originalPendingPoll = __testing.pendingByteArrayFfi.poll
  const originalPendingConsume = __testing.pendingByteArrayFfi.consume
  const originalPendingFree = __testing.pendingByteArrayFfi.free

  beforeEach(() => {
    process.env.TEMPORAL_BUN_SDK_USE_ZIG = '1'
    __testing.workerFfi.pollActivityTask = originalWorkerPoll
    __testing.pendingByteArrayFfi.poll = originalPendingPoll
    __testing.pendingByteArrayFfi.consume = originalPendingConsume
    __testing.pendingByteArrayFfi.free = originalPendingFree
  })

  describe('native.worker.pollActivityTask', () => {
    test('resolves activity payload when pending handle becomes ready', async () => {
      const handle = 0x101
      const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
      let pollCount = 0
      const freed: number[] = []

      __testing.workerFfi.pollActivityTask = () => handle
      __testing.pendingByteArrayFfi.poll = (incoming) => {
        expect(incoming).toBe(handle)
        return pollCount++ === 0 ? 0 : 1
      }
      __testing.pendingByteArrayFfi.consume = (incoming) => {
        expect(incoming).toBe(handle)
        return payload
      }
      __testing.pendingByteArrayFfi.free = (incoming) => {
        freed.push(incoming)
      }

      const result = await native.worker.pollActivityTask({ type: 'worker', handle: 0xbeef } as const)
      expect(result).toBeInstanceOf(Uint8Array)
      expect(result).not.toBe(payload)
      expect(Array.from(result ?? [])).toEqual(Array.from(payload))
      expect(freed).toEqual([handle])
    })

    test('returns null for shutdown sentinel payloads', async () => {
      const handle = 0x202
      __testing.workerFfi.pollActivityTask = () => handle
      __testing.pendingByteArrayFfi.poll = () => 1
      __testing.pendingByteArrayFfi.consume = () => new Uint8Array(0)
      __testing.pendingByteArrayFfi.free = () => {}

      const result = await native.worker.pollActivityTask({ type: 'worker', handle: 0xbeef } as const)
      expect(result).toBeNull()
    })

    test('surfaces NativeBridgeError when poll reports failure', async () => {
      const handle = 0x303
      __testing.workerFfi.pollActivityTask = () => handle
      __testing.pendingByteArrayFfi.poll = () => -1
      __testing.pendingByteArrayFfi.consume = () => {
        throw new Error('consume should not be called on failure')
      }
      __testing.pendingByteArrayFfi.free = () => {}

      await expect(native.worker.pollActivityTask({ type: 'worker', handle: 0xbeef } as const)).rejects.toBeInstanceOf(
        NativeBridgeError,
      )
    })
  })
}

process.env.TEMPORAL_BUN_SDK_USE_ZIG = originalEnvUseZig
