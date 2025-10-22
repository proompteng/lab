import { dlopen, FFIType, ptr, toArrayBuffer } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Pointer = number

type RuntimePtr = Pointer

type ClientPtr = Pointer

type WorkerPtr = Pointer

export interface Runtime {
  type: 'runtime'
  handle: RuntimePtr
}

export interface NativeClient {
  type: 'client'
  handle: ClientPtr
}

export interface NativeWorker {
  type: 'worker'
  handle: WorkerPtr
}

type BridgeVariant = 'zig'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolvePackageRoot()
const distNativeDir = join(packageRoot, 'dist', 'native')
const zigStageLibDir = join(packageRoot, 'native', 'temporal-bun-bridge-zig', 'zig-out', 'lib')

const { module: nativeModule } = loadBridgeLibrary()

export const bridgeVariant = 'zig'
export const isZigBridge = true

const UNKNOWN_NATIVE_ERROR_CODE = 2

export interface NativeBridgeErrorInit {
  code: number
  message: string
  details?: unknown
  raw?: string
}

export class NativeBridgeError extends Error {
  readonly code: number
  readonly details?: unknown
  readonly raw: string

  constructor(input: string | NativeBridgeErrorInit) {
    const payload: NativeBridgeErrorInit =
      typeof input === 'string'
        ? { code: UNKNOWN_NATIVE_ERROR_CODE, message: input, raw: input }
        : {
            code: input.code ?? UNKNOWN_NATIVE_ERROR_CODE,
            message: input.message ?? 'Unknown native error',
            details: input.details,
            raw: input.raw ?? input.message,
          }
    const message = payload.message ?? 'Unknown native error'
    super(message)
    this.name = 'NativeBridgeError'
    this.code = payload.code
    this.details = payload.details
    this.raw = payload.raw ?? message
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

interface BridgeLibraryLoadResult {
  module: ReturnType<typeof dlopen>
  path: string
  variant: BridgeVariant
}

interface BridgeLoadErrorContext {
  variant: BridgeVariant
  override: boolean
}

function loadBridgeLibrary(): BridgeLibraryLoadResult {
  const symbolMap = buildBridgeSymbolMap()
  const override = process.env.TEMPORAL_BUN_SDK_NATIVE_PATH
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`Temporal Bun bridge override not found at ${override}`)
    }
    try {
      return {
        module: dlopen(override, symbolMap),
        path: override,
        variant: 'zig',
      }
    } catch (error) {
      throw buildBridgeLoadError(override, error, { variant: 'zig', override: true })
    }
  }

  const candidatePath = resolveZigBridgeLibraryPath()

  try {
    return {
      module: dlopen(candidatePath, symbolMap),
      path: candidatePath,
      variant: 'zig',
    }
  } catch (error) {
    throw buildBridgeLoadError(candidatePath, error, { variant: 'zig', override: false })
  }
}

function buildBridgeSymbolMap() {
  return {
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
    temporal_bun_client_signal: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
    temporal_bun_client_signal_with_start: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
    temporal_bun_client_query_workflow: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
    temporal_bun_client_cancel_workflow: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
    temporal_bun_worker_new: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
    temporal_bun_worker_free: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
    temporal_bun_worker_poll_workflow_task: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    temporal_bun_worker_complete_workflow_task: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.int32_t,
    },
  }
}

function buildBridgeLoadError(libraryPath: string, error: unknown, context: BridgeLoadErrorContext): Error {
  const reason = error instanceof Error ? error.message : String(error)
  const messages = [`Failed to load Temporal Bun bridge at ${libraryPath}`]
  if (reason) {
    messages.push(`Reason: ${reason}`)
  }

  if (context.override) {
    messages.push('Verify TEMPORAL_BUN_SDK_NATIVE_PATH or rebuild the specified library for this platform.')
  }

  const failure = new NativeBridgeError(messages.join('. '))
  ;(failure as Error & { cause?: unknown }).cause = error
  return failure
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
    temporal_bun_client_signal,
    temporal_bun_client_signal_with_start,
    temporal_bun_client_query_workflow,
    temporal_bun_client_cancel_workflow,
    temporal_bun_worker_new,
    temporal_bun_worker_free,
    temporal_bun_worker_poll_workflow_task,
    temporal_bun_worker_complete_workflow_task,
    temporal_bun_worker_poll_activity_task,
    temporal_bun_worker_complete_activity_task,
    temporal_bun_worker_record_activity_heartbeat,
    temporal_bun_worker_initiate_shutdown,
    temporal_bun_worker_finalize_shutdown,
  },
} = nativeModule

export const native = {
  bridgeVariant: resolvedBridgeVariant,

  createRuntime(options: Record<string, unknown> = {}): Runtime {
    const payload = Buffer.from(JSON.stringify(options), 'utf8')
    const handle = Number(temporal_bun_runtime_new(ptr(payload), payload.byteLength))
    if (!handle) {
      throw buildNativeBridgeError()
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
      throw buildNativeBridgeError()
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
      throw buildNativeBridgeError()
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
      throw buildNativeBridgeError()
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
      throw buildNativeBridgeError()
    }
  },

  async signalWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<void> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const pendingHandle = Number(temporal_bun_client_signal(client.handle, ptr(payload), payload.byteLength))
    if (!pendingHandle) {
      throw buildNativeBridgeError()
    }
    try {
      await waitForByteArray(pendingHandle)
    } finally {
      temporal_bun_pending_byte_array_free(pendingHandle)
    }
  },

  async queryWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<Uint8Array> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const pendingHandle = Number(temporal_bun_client_query_workflow(client.handle, ptr(payload), payload.byteLength))
    if (!pendingHandle) {
      throw buildNativeBridgeError()
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
      throw buildNativeBridgeError()
    }
  },

  async cancelWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<void> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const pendingHandle = Number(temporal_bun_client_cancel_workflow(client.handle, ptr(payload), payload.byteLength))
    if (!pendingHandle) {
      throw buildNativeBridgeError()
    }
    try {
      await waitForByteArray(pendingHandle)
    } finally {
      temporal_bun_pending_byte_array_free(pendingHandle)
    }
  },

  async signalWithStart(client: NativeClient, request: Record<string, unknown>): Promise<Uint8Array> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const arrayPtr = Number(temporal_bun_client_signal_with_start(client.handle, ptr(payload), payload.byteLength))
    if (!arrayPtr) {
      throw buildNativeBridgeError()
    }
    return readByteArray(arrayPtr)
  },

  createWorker(runtime: Runtime, client: NativeClient, config: Record<string, unknown>): NativeWorker {
    const payload = Buffer.from(JSON.stringify(config), 'utf8')
    const handle = Number(temporal_bun_worker_new(runtime.handle, client.handle, ptr(payload), payload.byteLength))
    if (!handle) {
      throw buildNativeBridgeError()
    }
    return { type: 'worker', handle }
  },

  workerShutdown(worker: NativeWorker): void {
    temporal_bun_worker_free(worker.handle)
  },

  async workerPollWorkflowTask(worker: NativeWorker): Promise<Uint8Array | null> {
    const pendingHandle = Number(temporal_bun_worker_poll_workflow_task(worker.handle))
    if (!pendingHandle) {
      return null
    }
    try {
      return await waitForByteArray(pendingHandle)
    } finally {
      temporal_bun_pending_byte_array_free(pendingHandle)
    }
  },

  completeWorkflowTask(worker: NativeWorker, completion: Uint8Array): void {
    const status = Number(
      temporal_bun_worker_complete_workflow_task(worker.handle, ptr(completion), completion.byteLength),
    )
    if (status !== 0) {
      throw buildNativeBridgeError()
    }
  },

  async workerPollActivityTask(worker: NativeWorker): Promise<Uint8Array | null> {
    const pendingHandle = Number(temporal_bun_worker_poll_activity_task(worker.handle))
    if (!pendingHandle) {
      return null
    }
    try {
      return await waitForByteArray(pendingHandle)
    } finally {
      temporal_bun_pending_byte_array_free(pendingHandle)
    }
  },

  completeActivityTask(worker: NativeWorker, completion: Uint8Array): void {
    const status = Number(
      temporal_bun_worker_complete_activity_task(worker.handle, ptr(completion), completion.byteLength),
    )
    if (status !== 0) {
      throw buildNativeBridgeError()
    }
  },

  recordActivityHeartbeat(worker: NativeWorker, details: Uint8Array): void {
    const status = Number(
      temporal_bun_worker_record_activity_heartbeat(worker.handle, ptr(details), details.byteLength),
    )
    if (status !== 0) {
      throw buildNativeBridgeError()
    }
  },

  workerInitiateShutdown(worker: NativeWorker): void {
    const status = Number(temporal_bun_worker_initiate_shutdown(worker.handle))
    if (status !== 0) {
      throw buildNativeBridgeError()
    }
  },

  workerFinalizeShutdown(worker: NativeWorker): void {
    const status = Number(temporal_bun_worker_finalize_shutdown(worker.handle))
    if (status !== 0) {
      throw buildNativeBridgeError()
    }
  },
}

function resolvePackageRoot(): string {
  let dir = moduleDir
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      return dir
    }
    dir = join(dir, '..')
  }
  return join(moduleDir, '..', '..', '..', '..', '..')
}

interface ZigLookupResult {
  path: string | null
  attempted: string[]
}

interface BridgeResolution {
  resolvePath: () => string
  variant: BridgeVariant
}

interface ResolvedBridgeCandidate {
  path: string
  variant: BridgeVariant
}

function resolveZigBridgeLibraryPath(): string {
  const preference = getZigPreference()
  const attemptedPaths: string[] = []

  if (preference !== 'disable') {
    const packaged = resolvePackagedZigBridgeLibraryPath()
    attemptedPaths.push(...packaged.attempted)
    if (packaged.path) {
      return packaged.path
    }

    const local = resolveLocalZigBridgeLibraryPath()
    attemptedPaths.push(...local.attempted)
    if (local.path) {
      return local.path
    }
  }

  throw new NativeBridgeError(
    [
      `No Zig bridge binary was located for this platform.`,
      `Searched the following locations:`,
      ...(attemptedPaths.length ? [...new Set(attemptedPaths)].map((candidate) => `  • ${candidate}`) : ['  • <none>']),
    ].join('\n'),
  )
}

function getZigPreference(): ZigPreference {
  const flag = process.env.TEMPORAL_BUN_SDK_USE_ZIG
  if (!flag) {
    return 'auto'
  }
  if (/^(0|false|off)$/i.test(flag)) {
    return 'disable'
  }
  if (/^(1|true|on)$/i.test(flag)) {
    return 'enable'
  }
  return 'enable'
}

function resolvePackagedZigBridgeLibraryPath(): ZigLookupResult {
  const attempted: string[] = []
  const platform = getRuntimePlatform()
  const arch = getRuntimeArch()
  if (!platform || !arch) {
    return { path: null, attempted }
  }

  const releaseName = getZigReleaseLibraryName()
  const packagedPath = join(distNativeDir, platform, arch, releaseName)
  attempted.push(packagedPath)
  if (existsSync(packagedPath)) {
    return { path: packagedPath, attempted }
  }

  return { path: null, attempted }
}

function resolveLocalZigBridgeLibraryPath(): ZigLookupResult {
  const attempted: string[] = []
  const platform = getRuntimePlatform()
  const arch = getRuntimeArch()
  const releaseName = getZigReleaseLibraryName()
  const debugName = getZigDebugLibraryName()

  const candidates: string[] = []
  if (platform && arch) {
    candidates.push(join(zigStageLibDir, platform, arch, releaseName))
    candidates.push(join(zigStageLibDir, platform, arch, debugName))
  }
  candidates.push(join(zigStageLibDir, releaseName))
  candidates.push(join(zigStageLibDir, debugName))

  for (const candidate of candidates) {
    attempted.push(candidate)
    if (existsSync(candidate)) {
      return { path: candidate, attempted }
    }
  }

  return { path: null, attempted }
}

function getRuntimePlatform(): 'darwin' | 'linux' | null {
  if (process.platform === 'darwin') {
    return 'darwin'
  }
  if (process.platform === 'linux') {
    return 'linux'
  }
  return null
}

function getRuntimeArch(): 'arm64' | 'x64' | null {
  if (process.arch === 'arm64') {
    return 'arm64'
  }
  if (process.arch === 'x64') {
    return 'x64'
  }
  return null
}

function getZigReleaseLibraryName(): string {
  if (process.platform === 'win32') {
    return 'temporal_bun_bridge_zig.dll'
  }
  if (process.platform === 'darwin') {
    return 'libtemporal_bun_bridge_zig.dylib'
  }
  return 'libtemporal_bun_bridge_zig.so'
}

function getZigDebugLibraryName(): string {
  if (process.platform === 'win32') {
    return 'temporal_bun_bridge_zig_debug.dll'
  }
  if (process.platform === 'darwin') {
    return 'libtemporal_bun_bridge_zig_debug.dylib'
  }
  return 'libtemporal_bun_bridge_zig_debug.so'
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
            throw buildNativeBridgeError()
          }
          resolve(pointer)
        } catch (error) {
          reject(error)
        }
        return
      }

      reject(buildNativeBridgeError())
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
            throw buildNativeBridgeError()
          }
          resolve(readByteArray(arrayPtr))
        } catch (error) {
          reject(error)
        }
        return
      }

      // status === -1 or unexpected
      reject(buildNativeBridgeError())
    }

    setTimeout(poll, 0)
  })
}

function readLastErrorText(): string {
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

function readLastErrorPayload(): NativeBridgeErrorInit {
  const raw = readLastErrorText()
  if (!raw) {
    return {
      code: UNKNOWN_NATIVE_ERROR_CODE,
      message: 'Unknown native error',
      raw,
    }
  }

  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown; details?: unknown }
    if (typeof parsed.message === 'string') {
      return {
        code: typeof parsed.code === 'number' ? parsed.code : UNKNOWN_NATIVE_ERROR_CODE,
        message: parsed.message,
        details: parsed.details,
        raw,
      }
    }
  } catch {
    // fall through to default handling when the payload is not valid JSON
  }

  if (raw.startsWith('temporal-bun-bridge-zig:')) {
    const message = raw.replace(/^temporal-bun-bridge-zig:\s*/, '')
    const code = mapZigErrorCode(message)
    return {
      code,
      message,
      details: { source: 'zig', raw },
      raw: JSON.stringify({ code, message }),
    }
  }

  return {
    code: UNKNOWN_NATIVE_ERROR_CODE,
    message: raw,
    raw,
  }
}

function mapZigErrorCode(message: string): number {
  if (/received null runtime handle/i.test(message)) {
    return 3
  }
  if (/is not implemented yet/i.test(message)) {
    return 12
  }
  return UNKNOWN_NATIVE_ERROR_CODE
}

function buildNativeBridgeError(): NativeBridgeError {
  return new NativeBridgeError(readLastErrorPayload())
}

function buildNotImplementedError(feature: string, docPath: string): Error {
  return new Error(
    `${feature} is not implemented yet. See packages/temporal-bun-sdk/${docPath} for the implementation plan.`,
  )
}

function notImplemented(feature: string, docPath: string): never {
  throw buildNotImplementedError(feature, docPath)
}
