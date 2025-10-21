import { dlopen, FFIType, ptr } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildTemporalBridgeError, TemporalBridgeError, TemporalBridgeErrorCode } from './errors'

const LIBRARY_FILENAMES = {
  darwin: 'libtemporal_bun_bridge_zig.dylib',
  linux: 'libtemporal_bun_bridge_zig.so',
} as const

type SupportedPlatform = keyof typeof LIBRARY_FILENAMES

const symbolMap = {
  te_client_connect: { args: [FFIType.ptr], returns: FFIType.int32_t },
  te_client_close: { args: [FFIType.uint64_t], returns: FFIType.int32_t },
  te_worker_start: { args: [FFIType.uint64_t, FFIType.ptr], returns: FFIType.int32_t },
  te_worker_shutdown: { args: [FFIType.uint64_t], returns: FFIType.int32_t },
  te_get_last_error: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.int32_t },
  te_free_buf: { args: [FFIType.uint64_t, FFIType.int64_t], returns: FFIType.int32_t },
} as const

const moduleDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(moduleDir, '..')
const defaultLibDir = join(packageRoot, 'native', 'temporal-bun-bridge-zig', 'zig-out', 'lib')

const libraryPath = resolveLibraryPath()

const nativeModule = dlopen(libraryPath, symbolMap)
const symbols = nativeModule.symbols

const LIBC_FILENAMES = {
  darwin: 'libSystem.B.dylib',
  linux: 'libc.so.6',
} as const

const libcPath = LIBC_FILENAMES[process.platform as keyof typeof LIBC_FILENAMES]
if (!libcPath) {
  throw new Error(`Unsupported platform ${process.platform} for libc bindings`)
}

const libcModule = dlopen(libcPath, {
  memcpy: { args: [FFIType.ptr, FFIType.uint64_t, FFIType.uint64_t], returns: FFIType.uint64_t },
} as const)
const libcSymbols = libcModule.symbols

export const nativeBridgePath = libraryPath

export type NativeHandle = bigint

export function clientConnect(): NativeHandle {
  const out = new BigUint64Array(1)
  ensureOk(symbols.te_client_connect(ptr(out)), 'te_client_connect')
  return out[0]
}

export function clientClose(handle: NativeHandle | number): void {
  ensureOk(symbols.te_client_close(normalizeHandle(handle)), 'te_client_close')
}

export function workerStart(client: NativeHandle | number): NativeHandle {
  const out = new BigUint64Array(1)
  ensureOk(symbols.te_worker_start(normalizeHandle(client), ptr(out)), 'te_worker_start')
  return out[0]
}

export function workerShutdown(handle: NativeHandle | number): void {
  ensureOk(symbols.te_worker_shutdown(normalizeHandle(handle)), 'te_worker_shutdown')
}

function getLastErrorRaw(): { status: number; ptr: bigint; len: bigint } {
  const ptrBuffer = new BigUint64Array(1)
  const lenBuffer = new BigUint64Array(1)
  const status = symbols.te_get_last_error(ptr(ptrBuffer), ptr(lenBuffer))
  return { status, ptr: ptrBuffer[0], len: lenBuffer[0] }
}

export const __testing = {
  getLastErrorRaw,
  freeBuffer(pointer: bigint, length: number | bigint): number {
    return symbols.te_free_buf(pointer, Number(length))
  },
  callClientClose(handle: NativeHandle | number): number {
    return symbols.te_client_close(normalizeHandle(handle))
  },
  drainErrorSlot() {
    const result = getLastErrorRaw()
    if (result.status !== 0) {
      throw new Error(`te_get_last_error failed with status ${result.status}`)
    }
    if (result.ptr !== 0n && result.len > 0n) {
      const freeStatus = symbols.te_free_buf(result.ptr, Number(result.len))
      if (freeStatus !== 0 && freeStatus !== TemporalBridgeErrorCode.NotFound) {
        throw new Error(`te_free_buf failed with status ${freeStatus}`)
      }
    }
    return result
  },
}

function ensureOk(status: number, where: string): void {
  if (status === 0) {
    return
  }
  throwNativeError(where, status)
}

function throwNativeError(where: string, status: number): never {
  const buffer = readErrorBuffer(where, status)
  throw buildTemporalBridgeError({
    status,
    where,
    buffer,
    fallbackMessage: `Native error ${status} at ${where}`,
  })
}

function readErrorBuffer(where: string, status: number): Uint8Array | null {
  const { status: getStatus, ptr: pointer, len: length } = getLastErrorRaw()
  if (getStatus !== 0) {
    throw new TemporalBridgeError({
      code: getStatus,
      message: `te_get_last_error failed after ${where}(${status})`,
      where: 'te_get_last_error',
      raw: '',
    })
  }

  if (pointer === 0n || length === 0n) {
    return null
  }

  const lengthNumber = Number(length)

  let payload: Uint8Array | null = null
  let pendingError: TemporalBridgeError | null = null
  try {
    payload = copyFromPointer(pointer, lengthNumber)
  } catch (error) {
    pendingError = new TemporalBridgeError({
      code: TemporalBridgeErrorCode.Internal,
      message: `Failed to read native error buffer for ${where}`,
      where,
      raw: '',
      cause: error,
    })
  } finally {
    const freeStatus = symbols.te_free_buf(pointer, lengthNumber)
    if (freeStatus !== 0) {
      if (!pendingError) {
        pendingError = new TemporalBridgeError({
          code: freeStatus,
          message: 'te_free_buf failed while releasing native error buffer',
          where: 'te_free_buf',
          raw: '',
        })
      }
    }
  }

  if (pendingError) {
    throw pendingError
  }

  return payload ?? null
}

function normalizeHandle(handle: NativeHandle | number): number {
  return typeof handle === 'bigint' ? Number(handle) : handle
}

function copyFromPointer(pointer: bigint, length: number): Uint8Array {
  if (length === 0) {
    return new Uint8Array(0)
  }

  const result = new Uint8Array(length)
  libcSymbols.memcpy(ptr(result), pointer, BigInt(length))
  return result
}

function resolveLibraryPath(): string {
  const override = process.env.TEMPORAL_BUN_BRIDGE_PATH
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`Temporal Bun bridge override not found at ${override}`)
    }
    return override
  }

  const platform = process.platform as SupportedPlatform
  const filename = LIBRARY_FILENAMES[platform]
  if (!filename) {
    throw new Error(`Unsupported platform ${process.platform} for Temporal Bun bridge`)
  }

  const candidate = join(defaultLibDir, filename)
  if (!existsSync(candidate)) {
    throw new Error(
      `Temporal Bun Zig bridge not found at ${candidate}. Run \`zig build -Doptimize=ReleaseFast --build-file native/temporal-bun-bridge-zig/build.zig\` first.`,
    )
  }

  return candidate
}
