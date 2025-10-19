import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Pointer = number

type RuntimePtr = Pointer

type ClientPtr = Pointer

export interface Runtime {
  type: 'runtime'
  handle: RuntimePtr
}

export interface NativeClient {
  type: 'client'
  handle: ClientPtr
}

type BridgeVariant = 'zig' | 'rust'

const libraryFile = resolveBridgeLibraryPath()
const resolvedBridgeVariant: BridgeVariant = libraryFile.includes('temporal-bun-bridge-zig') ? 'zig' : 'rust'

export const bridgeVariant = resolvedBridgeVariant
export const isZigBridge = resolvedBridgeVariant === 'zig'

export class NativeBridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NativeBridgeError'
  }
}

const {
  symbols: {
    temporal_bun_runtime_new,
    temporal_bun_runtime_free,
    temporal_bun_error_message,
    temporal_bun_error_free,
    temporal_bun_client_connect_async,
    temporal_bun_client_free,
    temporal_bun_client_describe_namespace_async,
    temporal_bun_client_update_headers,
    temporal_bun_pending_client_poll,
    temporal_bun_pending_client_consume,
    temporal_bun_pending_client_free,
    temporal_bun_pending_byte_array_poll,
    temporal_bun_pending_byte_array_consume,
    temporal_bun_pending_byte_array_free,
    temporal_bun_byte_array_free,
    temporal_bun_client_start_workflow,
    temporal_bun_client_terminate_workflow,
    temporal_bun_client_signal_with_start,
    temporal_bun_client_query_workflow,
  },
} = dlopen(libraryFile, {
  temporal_bun_runtime_new: {
    args: [FFIType.ptr, FFIType.uint64_t],
    returns: FFIType.ptr,
  },
  temporal_bun_runtime_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  temporal_bun_error_message: {
    args: [FFIType.ptr],
    returns: FFIType.ptr,
  },
  temporal_bun_error_free: {
    args: [FFIType.ptr, FFIType.uint64_t],
    returns: FFIType.void,
  },
  temporal_bun_client_connect_async: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
    returns: FFIType.ptr,
  },
  temporal_bun_client_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  temporal_bun_client_describe_namespace_async: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
    returns: FFIType.ptr,
  },
  temporal_bun_client_update_headers: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
    returns: FFIType.int32_t,
  },
  temporal_bun_pending_client_poll: {
    args: [FFIType.ptr],
    returns: FFIType.int32_t,
  },
  temporal_bun_pending_client_consume: {
    args: [FFIType.ptr],
    returns: FFIType.ptr,
  },
  temporal_bun_pending_client_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  temporal_bun_pending_byte_array_poll: {
    args: [FFIType.ptr],
    returns: FFIType.int32_t,
  },
  temporal_bun_pending_byte_array_consume: {
    args: [FFIType.ptr],
    returns: FFIType.ptr,
  },
  temporal_bun_pending_byte_array_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  temporal_bun_byte_array_free: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  temporal_bun_client_start_workflow: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
    returns: FFIType.ptr,
  },
  temporal_bun_client_terminate_workflow: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
    returns: FFIType.int32_t,
  },
  temporal_bun_client_signal_with_start: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
    returns: FFIType.ptr,
  },
  temporal_bun_client_query_workflow: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
    returns: FFIType.ptr,
  },
})

export const native = {
  bridgeVariant: resolvedBridgeVariant,

  createRuntime(options: Record<string, unknown> = {}): Runtime {
    const payload = Buffer.from(JSON.stringify(options), 'utf8')
    const handle = Number(temporal_bun_runtime_new(ptr(payload), payload.byteLength))
    if (!handle) {
      throw new Error(readLastError())
    }
    return { type: 'runtime', handle }
  },

  runtimeShutdown(runtime: Runtime): void {
    temporal_bun_runtime_free(runtime.handle)
  },

  async createClient(runtime: Runtime, config: Record<string, unknown>): Promise<NativeClient> {
    const payload = Buffer.from(JSON.stringify(config), 'utf8')
    const pendingHandle = Number(temporal_bun_client_connect_async(runtime.handle, ptr(payload), payload.byteLength))
    if (!pendingHandle) {
      throw new Error(readLastError())
    }
    try {
      const handle = await waitForClientHandle(pendingHandle)
      return { type: 'client', handle }
    } finally {
      temporal_bun_pending_client_free(pendingHandle)
    }
  },

  clientShutdown(client: NativeClient): void {
    temporal_bun_client_free(client.handle)
  },

  async describeNamespace(client: NativeClient, namespace: string): Promise<Uint8Array> {
    const payload = Buffer.from(JSON.stringify({ namespace }), 'utf8')
    const pendingHandle = Number(
      temporal_bun_client_describe_namespace_async(client.handle, ptr(payload), payload.byteLength),
    )
    if (!pendingHandle) {
      throw new Error(readLastError())
    }
    try {
      return await waitForByteArray(pendingHandle)
    } finally {
      temporal_bun_pending_byte_array_free(pendingHandle)
    }
  },

  async startWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<Uint8Array> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const arrayPtr = Number(temporal_bun_client_start_workflow(client.handle, ptr(payload), payload.byteLength))
    if (!arrayPtr) {
      throw new Error(readLastError())
    }
    return readByteArray(arrayPtr)
  },

  configureTelemetry(runtime: Runtime, options: Record<string, unknown> = {}): never {
    void runtime
    void options
    // TODO(codex): Bridge telemetry configuration through `temporal_bun_runtime_update_telemetry`
    // per packages/temporal-bun-sdk/docs/ffi-surface.md (Function Matrix, Runtime section).
    return notImplemented('Runtime telemetry configuration', 'docs/ffi-surface.md')
  },

  installLogger(runtime: Runtime, _callback: (...args: unknown[]) => void): never {
    void runtime
    // TODO(codex): Install Bun logger hook via `temporal_bun_runtime_set_logger` once the native bridge
    // supports forwarding core logs (docs/ffi-surface.md — Runtime exports).
    return notImplemented('Runtime logger installation', 'docs/ffi-surface.md')
  },

  updateClientHeaders(client: NativeClient, headers: Record<string, string>): void {
    const payload = Buffer.from(JSON.stringify(headers ?? {}), 'utf8')
    const status = Number(temporal_bun_client_update_headers(client.handle, ptr(payload), payload.byteLength))
    if (status !== 0) {
      throw new NativeBridgeError(readLastError())
    }
  },

  async signalWorkflow(client: NativeClient, _request: Record<string, unknown>): Promise<never> {
    void client
    void _request
    // TODO(codex): Call into `temporal_bun_client_signal` once implemented to deliver workflow signals
    // per the packages/temporal-bun-sdk/docs/ffi-surface.md function matrix.
    return Promise.reject(buildNotImplementedError('Workflow signal bridge', 'docs/ffi-surface.md'))
  },

  async queryWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<Uint8Array> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const pendingHandle = Number(temporal_bun_client_query_workflow(client.handle, ptr(payload), payload.byteLength))
    if (!pendingHandle) {
      throw new Error(readLastError())
    }
    try {
      return await waitForByteArray(pendingHandle)
    } finally {
      temporal_bun_pending_byte_array_free(pendingHandle)
    }
  },

  async terminateWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<void> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const status = Number(temporal_bun_client_terminate_workflow(client.handle, ptr(payload), payload.byteLength))
    if (status !== 0) {
      throw new Error(readLastError())
    }
  },

  async cancelWorkflow(client: NativeClient, _request: Record<string, unknown>): Promise<never> {
    void client
    void _request
    // TODO(codex): Route cancellations through `temporal_bun_client_cancel_workflow` when the FFI export
    // exists (docs/ffi-surface.md).
    return Promise.reject(buildNotImplementedError('Workflow cancel bridge', 'docs/ffi-surface.md'))
  },

  async signalWithStart(client: NativeClient, request: Record<string, unknown>): Promise<Uint8Array> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const arrayPtr = Number(temporal_bun_client_signal_with_start(client.handle, ptr(payload), payload.byteLength))
    if (!arrayPtr) {
      throw new Error(readLastError())
    }
    return readByteArray(arrayPtr)
  },
}

function resolveBridgeLibraryPath(): string {
  const override = process.env.TEMPORAL_BUN_SDK_NATIVE_PATH
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`Temporal Bun bridge override not found at ${override}`)
    }
    return override
  }

  if (shouldPreferZigBridge()) {
    const zigPath = resolveZigBridgeLibraryPath()
    if (zigPath) {
      return zigPath
    }
    console.warn(
      'TEMPORAL_BUN_SDK_USE_ZIG was enabled but the Zig bridge was not found. Falling back to the Rust bridge.',
    )
  }

  return resolveRustBridgeLibraryPath()
}

function shouldPreferZigBridge(): boolean {
  const flag = process.env.TEMPORAL_BUN_SDK_USE_ZIG
  if (!flag) {
    return false
  }
  return /^(1|true|on)$/i.test(flag)
}

function resolveZigBridgeLibraryPath(): string | null {
  const baseDir = fileURLToPath(new URL('../../../native/temporal-bun-bridge-zig', import.meta.url))
  const libDir = join(baseDir, 'zig-out', 'lib')
  const baseName =
    process.platform === 'win32'
      ? 'temporal_bun_bridge_zig.dll'
      : process.platform === 'darwin'
        ? 'libtemporal_bun_bridge_zig.dylib'
        : 'libtemporal_bun_bridge_zig.so'

  const releasePath = join(libDir, baseName)
  if (existsSync(releasePath)) {
    return releasePath
  }

  const debugName =
    process.platform === 'win32'
      ? 'temporal_bun_bridge_zig_debug.dll'
      : process.platform === 'darwin'
        ? 'libtemporal_bun_bridge_zig_debug.dylib'
        : 'libtemporal_bun_bridge_zig_debug.so'

  const debugPath = join(libDir, debugName)
  if (existsSync(debugPath)) {
    return debugPath
  }

  // TODO(codex, temporal-zig-phase-0): surface richer diagnostics (include zig build command output, etc.)
  return null
}

function resolveRustBridgeLibraryPath(): string {
  const targetDir = fileURLToPath(new URL('../../../native/temporal-bun-bridge/target', import.meta.url))
  const baseName =
    process.platform === 'win32'
      ? 'temporal_bun_bridge.dll'
      : process.platform === 'darwin'
        ? 'libtemporal_bun_bridge.dylib'
        : 'libtemporal_bun_bridge.so'

  const releasePath = join(targetDir, 'release', baseName)
  if (existsSync(releasePath)) {
    return releasePath
  }

  const debugPath = join(targetDir, 'debug', baseName)
  if (existsSync(debugPath)) {
    return debugPath
  }

  const depsDir = join(targetDir, 'debug', 'deps')
  if (existsSync(depsDir)) {
    const prefix = baseName.replace(/\.[^./]+$/, '')
    const candidate = readdirSync(depsDir)
      .filter((file) => file.startsWith(prefix))
      .map((file) => join(depsDir, file))
      .find((file) => existsSync(file))
    if (candidate) {
      return candidate
    }
  }

  throw new Error(
    `Temporal Bun bridge library not found. Expected at ${releasePath} or ${debugPath}. Did you build the native bridge?`,
  )
}

function readByteArray(pointer: number): Uint8Array {
  const header = new BigUint64Array(toArrayBuffer(pointer, 0, 24))
  const dataPtr = Number(header[0])
  const len = Number(header[1])
  const view = new Uint8Array(toArrayBuffer(dataPtr, 0, len))
  // Copy into JS-owned memory before the native buffer is released.
  const copy = new Uint8Array(view)
  temporal_bun_byte_array_free(pointer)
  return copy
}

async function waitForClientHandle(handle: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const poll = (): void => {
      const status = Number(temporal_bun_pending_client_poll(handle))
      if (status === 0) {
        setTimeout(poll, 0)
        return
      }

      if (status === 1) {
        try {
          const pointer = Number(temporal_bun_pending_client_consume(handle))
          if (!pointer) {
            throw new Error(readLastError())
          }
          resolve(pointer)
        } catch (error) {
          reject(error)
        }
        return
      }

      reject(new Error(readLastError()))
    }

    setTimeout(poll, 0)
  })
}

async function waitForByteArray(handle: number): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const poll = (): void => {
      const status = Number(temporal_bun_pending_byte_array_poll(handle))
      if (status === 0) {
        setTimeout(poll, 0)
        return
      }

      if (status === 1) {
        try {
          const arrayPtr = Number(temporal_bun_pending_byte_array_consume(handle))
          if (!arrayPtr) {
            throw new Error(readLastError())
          }
          resolve(readByteArray(arrayPtr))
        } catch (error) {
          reject(error)
        }
        return
      }

      // status === -1 or unexpected
      reject(new Error(readLastError()))
    }

    setTimeout(poll, 0)
  })
}

function readLastError(): string {
  const lenBuffer = new BigUint64Array(1)
  const errPtr = Number(temporal_bun_error_message(ptr(lenBuffer)))
  const len = Number(lenBuffer[0])
  if (!errPtr || len === 0) {
    return 'Unknown native error'
  }
  try {
    const buffer = Buffer.from(toArrayBuffer(errPtr, 0, len))
    return buffer.toString('utf8')
  } finally {
    temporal_bun_error_free(errPtr, len)
  }
}

function buildNotImplementedError(feature: string, docPath: string): Error {
  return new Error(
    `${feature} is not implemented yet. See packages/temporal-bun-sdk/${docPath} for the implementation plan.`,
  )
}

function notImplemented(feature: string, docPath: string): never {
  throw buildNotImplementedError(feature, docPath)
}
