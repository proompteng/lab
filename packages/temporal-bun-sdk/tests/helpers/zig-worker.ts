import { dlopen, FFIType, type Pointer, ptr, toArrayBuffer } from 'bun:ffi'
import { Buffer } from 'node:buffer'

const modeMap = {
  success: 0,
  failure: 1,
  shutdown: 2,
} as const

type PollModeKey = keyof typeof modeMap

export function createWorkerTestHelpers(libraryPath: string) {
  const symbols = {
    temporal_bun_test_worker_install_poll_stub: { args: [], returns: FFIType.void },
    temporal_bun_test_worker_set_mode: { args: [FFIType.uint8_t], returns: FFIType.int32_t },
    temporal_bun_test_worker_handle: { args: [], returns: FFIType.ptr },
    temporal_bun_test_worker_reset: { args: [], returns: FFIType.void },
    temporal_bun_test_worker_install_completion_stub: { args: [], returns: FFIType.void },
    temporal_bun_test_worker_set_poll_payload: { args: [FFIType.ptr, FFIType.uint64_t], returns: FFIType.int32_t },
    temporal_bun_test_worker_completion_count: { args: [], returns: FFIType.uint64_t },
    temporal_bun_test_worker_completion_size: { args: [], returns: FFIType.uint64_t },
    temporal_bun_test_worker_consume_completion: { args: [FFIType.ptr, FFIType.uint64_t], returns: FFIType.int32_t },
  } as const

  const { symbols: helper } = dlopen(libraryPath, symbols)

  return {
    install() {
      helper.temporal_bun_test_worker_install_poll_stub()
    },
    installCompletionStub() {
      helper.temporal_bun_test_worker_install_completion_stub()
    },
    setMode(mode: PollModeKey) {
      const rc = helper.temporal_bun_test_worker_set_mode(modeMap[mode])
      if (rc !== 0) {
        throw new Error(`Failed to set worker poll mode: ${mode}`)
      }
    },
    setWorkflowActivationPayload(payload: Uint8Array | Buffer) {
      const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      const rc = helper.temporal_bun_test_worker_set_poll_payload(ptr(buffer), buffer.byteLength)
      if (rc !== 0) {
        throw new Error('Failed to configure worker poll payload')
      }
    },
    handle(): Pointer {
      return helper.temporal_bun_test_worker_handle()
    },
    takeCompletion(): Uint8Array | null {
      const size = Number(helper.temporal_bun_test_worker_completion_size())
      if (size === 0) {
        helper.temporal_bun_test_worker_consume_completion(0 as unknown as Pointer, 0)
        return new Uint8Array(0)
      }

      const buffer = new Uint8Array(size)
      const status = Number(helper.temporal_bun_test_worker_consume_completion(ptr(buffer), buffer.byteLength))
      if (status !== 0) {
        throw new Error('Failed to consume recorded workflow completion payload')
      }

      return buffer
    },
    completionCount(): number {
      return Number(helper.temporal_bun_test_worker_completion_count())
    },
    reset() {
      helper.temporal_bun_test_worker_reset()
    },
  }
}
