import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeNativeError, type NativeErrorPayload, TemporalBridgeError } from './errors.ts'

const StatusCodes = {
  ok: 0,
  invalidArgument: 1,
  notFound: 2,
  alreadyClosed: 3,
  busy: 4,
  internal: 5,
  oom: 6,
} as const

export type StatusCode = (typeof StatusCodes)[keyof typeof StatusCodes]

const symbolMap = {
  te_client_connect: {
    args: [FFIType.ptr, FFIType.int64_t, FFIType.ptr],
    returns: FFIType.int32_t,
  },
  te_client_close: {
    args: [FFIType.uint64_t],
    returns: FFIType.int32_t,
  },
  te_worker_start: {
    args: [FFIType.uint64_t, FFIType.ptr, FFIType.int64_t, FFIType.ptr],
    returns: FFIType.int32_t,
  },
  te_worker_shutdown: {
    args: [FFIType.uint64_t],
    returns: FFIType.int32_t,
  },
  te_get_last_error: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.int32_t,
  },
  te_free_buf: {
    args: [FFIType.uint64_t, FFIType.int64_t],
    returns: FFIType.int32_t,
  },
} as const

type NativeModule = ReturnType<typeof dlopen>

type NativeSymbols = NativeModule['symbols']

const TEMPORAL_BRIDGE_ENV = 'TEMPORAL_BUN_BRIDGE_PATH'

const libraryPath = resolveLibraryPath()
const nativeModule = dlopen(libraryPath, symbolMap)
const native: NativeSymbols = nativeModule.symbols

function resolveLibraryPath(): string {
  const override = process.env[TEMPORAL_BRIDGE_ENV]
  if (override) {
    if (!existsSync(override)) {
      throw new TemporalBridgeError({
        code: StatusCodes.notFound,
        msg: `Temporal bridge override not found at ${override}`,
        where: 'resolveLibraryPath',
        raw: override,
      })
    }
    return override
  }

  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const nativeRoot = join(packageRoot, 'native', 'temporal-bun-bridge-zig', 'zig-out', 'lib')
  const filename = selectLibraryFilename()
  const candidate = join(nativeRoot, filename)
  if (!existsSync(candidate)) {
    throw new TemporalBridgeError({
      code: StatusCodes.notFound,
      msg: `Temporal bridge library not found at ${candidate}`,
      where: 'resolveLibraryPath',
      raw: candidate,
    })
  }
  return candidate
}

function selectLibraryFilename(): string {
  switch (process.platform) {
    case 'darwin':
      return 'libtemporal_bun_bridge_zig.dylib'
    case 'win32':
      return 'temporal_bun_bridge_zig.dll'
    default:
      return 'libtemporal_bun_bridge_zig.so'
  }
}

export function connectClient(config?: ArrayBufferView | ArrayBuffer | null): bigint {
  const configBuffer = encodeConfig(config)
  const outHandle = new BigUint64Array(1)
  const status = native.te_client_connect(configBuffer.pointer, configBuffer.length, ptr(outHandle))
  void configBuffer.view
  ensureStatus(status, 'te_client_connect')
  return outHandle[0]
}

export function closeClient(handle: bigint): void {
  ensureStatus(native.te_client_close(handle), 'te_client_close')
}

export function startWorker(clientHandle: bigint, options?: ArrayBufferView | ArrayBuffer | null): bigint {
  const optionsBuffer = encodeConfig(options)
  const outHandle = new BigUint64Array(1)
  const status = native.te_worker_start(clientHandle, optionsBuffer.pointer, optionsBuffer.length, ptr(outHandle))
  void optionsBuffer.view
  ensureStatus(status, 'te_worker_start')
  return outHandle[0]
}

export function shutdownWorker(handle: bigint): void {
  ensureStatus(native.te_worker_shutdown(handle), 'te_worker_shutdown')
}

export function drainErrorForTest(): NativeErrorPayload | null {
  return drainNativeError()
}

function ensureStatus(status: number, where: string): void {
  if (status === StatusCodes.ok) {
    return
  }
  const payload = drainNativeError()
  if (payload) {
    throw new TemporalBridgeError(payload)
  }
  throw new TemporalBridgeError({
    code: status,
    msg: `${where} failed with status ${status}`,
    where,
    raw: `${where}:${status}`,
  })
}

function drainNativeError(): NativeErrorPayload | null {
  const ptrBox = new BigUint64Array(1)
  const lenBox = new BigUint64Array(1)
  const status = native.te_get_last_error(ptr(ptrBox), ptr(lenBox))
  if (status === StatusCodes.notFound) {
    return null
  }
  if (status !== StatusCodes.ok) {
    throw new TemporalBridgeError({
      code: status,
      msg: `te_get_last_error failed with status ${status}`,
      where: 'te_get_last_error',
      raw: String(status),
    })
  }

  const ptrValue = ptrBox[0]
  const lenValue = lenBox[0]
  if (ptrValue === 0n || lenValue === 0n) {
    return null
  }

  const length = ensureSafeLength(lenValue, 'te_get_last_error')
  const pointer = ensureSafePointer(ptrValue, 'te_get_last_error')
  const copy = copyNativeBuffer(pointer, length)

  let decoded: NativeErrorPayload | undefined
  let caught: unknown | undefined
  try {
    decoded = decodeNativeError(copy)
  } catch (error) {
    caught = error
  }

  const freeStatus = native.te_free_buf(ptrValue, length)
  if (freeStatus !== StatusCodes.ok) {
    throw new TemporalBridgeError({
      code: freeStatus,
      msg: `te_free_buf failed with status ${freeStatus}`,
      where: 'te_get_last_error',
      raw: String(freeStatus),
    })
  }

  if (caught) {
    throw caught
  }

  if (!decoded) {
    throw new TemporalBridgeError({
      code: StatusCodes.internal,
      msg: 'decodeNativeError returned empty payload',
      where: 'te_get_last_error',
      raw: 'decodeNativeError',
    })
  }

  return decoded
}

function encodeConfig(data?: ArrayBufferView | ArrayBuffer | null): {
  pointer: number
  length: number
  view?: Uint8Array
} {
  if (!data) {
    return { pointer: 0, length: 0 }
  }

  const view =
    data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (view.byteLength === 0) {
    return { pointer: 0, length: 0, view }
  }
  return { pointer: ptr(view), length: view.byteLength, view }
}

function ensureSafePointer(value: bigint, where: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TemporalBridgeError({
      code: StatusCodes.internal,
      msg: `${where} returned pointer exceeding JS precision`,
      where,
      raw: value.toString(),
    })
  }
  return Number(value)
}

function ensureSafeLength(value: bigint, where: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TemporalBridgeError({
      code: StatusCodes.internal,
      msg: `${where} returned length exceeding JS precision`,
      where,
      raw: value.toString(),
    })
  }
  return Number(value)
}

function copyNativeBuffer(pointer: number, length: number): Uint8Array {
  if (length === 0) {
    return new Uint8Array(0)
  }
  const buffer = toArrayBuffer(pointer, length)
  const copy = new Uint8Array(length)
  copy.set(new Uint8Array(buffer))
  return copy
}

export { StatusCodes }
