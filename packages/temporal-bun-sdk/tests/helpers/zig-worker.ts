import { dlopen, FFIType, type Pointer } from 'bun:ffi'

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
  } as const

  const { symbols: helper } = dlopen(libraryPath, symbols)

  return {
    install() {
      helper.temporal_bun_test_worker_install_poll_stub()
    },
    setMode(mode: PollModeKey) {
      const rc = helper.temporal_bun_test_worker_set_mode(modeMap[mode])
      if (rc !== 0) {
        throw new Error(`Failed to set worker poll mode: ${mode}`)
      }
    },
    handle(): Pointer {
      return helper.temporal_bun_test_worker_handle()
    },
    reset() {
      helper.temporal_bun_test_worker_reset()
    },
  }
}
