import { dlopen, FFIType, JSCallback, type Pointer, ptr, toArrayBuffer } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DefaultPayloadConverter } from '@temporalio/common'
import { temporal } from '@temporalio/proto'

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
const zigStageLibDir = join(packageRoot, 'bruke', 'zig-out', 'lib')

const UNKNOWN_NATIVE_ERROR_CODE = 2
const payloadConverter = new DefaultPayloadConverter()

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

export type TemporalCoreLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface TemporalCoreLogEvent {
  level: TemporalCoreLogLevel
  levelIndex: number
  target: string
  message: string
  timestampMillis: number
  fieldsJson?: string
  fields?: unknown
}

export type TemporalCoreLogger = (event: TemporalCoreLogEvent) => void

type ZigPreference = 'auto' | 'enable' | 'disable'

interface BridgeLibraryLoadResult {
  module: ReturnType<typeof dlopen>
  path: string
  variant: BridgeVariant
}

interface BridgeLoadErrorContext {
  variant: BridgeVariant
  preference: ZigPreference
  override: boolean
}

interface LoggerRegistration {
  runtime: Runtime
  jsCallback: JSCallback
  onDetach?: () => void
}

const nativeLogLevels: readonly TemporalCoreLogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'] as const
const utf8Decoder = new TextDecoder('utf-8')
const runtimeLoggerState = new Map<number, LoggerRegistration>()

const decodeUtf8 = (pointer: Pointer, length: number): string => {
  if (!pointer || length === 0) return ''
  return utf8Decoder.decode(new Uint8Array(toArrayBuffer(pointer, length)))
}

const pointerFromBuffer = (buffer: Buffer | null): Pointer => {
  if (!buffer || buffer.length === 0) {
    return 0 as unknown as Pointer
  }
  return ptr(buffer)
}

const mapLogLevel = (levelIndex: number): TemporalCoreLogLevel => {
  const value = nativeLogLevels[levelIndex]
  return value ?? 'info'
}

const parseFields = (json?: string): unknown => {
  if (!json || json.length === 0) {
    return undefined
  }
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

const detachLoggerOrThrow = (runtime: Runtime): void => {
  const status = Number(temporal_bun_runtime_set_logger(runtime.handle, 0))
  if (status !== 0) {
    throw buildNativeBridgeError()
  }

  const handleId = Number(runtime.handle)
  const registration = runtimeLoggerState.get(handleId)
  if (registration) {
    runtimeLoggerState.delete(handleId)
    try {
      registration.onDetach?.()
    } catch {}
    registration.jsCallback.close()
  }
}

const detachLoggerUnsafe = (runtime: Runtime): void => {
  try {
    detachLoggerOrThrow(runtime)
  } catch {}
}

function loadBridgeLibrary(): BridgeLibraryLoadResult {
  const symbolMap = buildBridgeSymbolMap()
  const override = process.env.TEMPORAL_BUN_SDK_NATIVE_PATH
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`Temporal Bun bridge override not found at ${override}`)
    }
    ensureZigBridgePath(override)
    try {
      return {
        module: dlopen(override, symbolMap),
        path: override,
        variant: 'zig',
      }
    } catch (error) {
      throw buildBridgeLoadError(override, error, {
        variant: 'zig',
        preference: 'enable',
        override: true,
      })
    }
  }

  const preference = getZigPreference()
  if (preference === 'disable') {
    throw new NativeBridgeError(
      'TEMPORAL_BUN_SDK_USE_ZIG=0 is no longer supported. The Rust bridge has been removed; build the Zig bridge with "pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig" instead.',
    )
  }

  const candidates = resolveBridgeLibraryCandidates(preference)
  if (candidates.length === 0) {
    throw new NativeBridgeError(
      'No Zig bridge artefacts were found. Run "pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig" to compile the bridge, or publish prebuilt artefacts alongside the package.',
    )
  }

  let lastError: unknown = null
  let lastCandidate: ResolvedBridgeCandidate | null = null

  for (const candidate of candidates) {
    let candidatePath: string

    try {
      candidatePath = candidate.resolvePath()
    } catch (error) {
      lastError = error
      logZigBridgeLoadFailure('(failed to resolve Zig bridge path)', error)
      continue
    }

    try {
      return {
        module: dlopen(candidatePath, symbolMap),
        path: candidatePath,
        variant: candidate.variant,
      }
    } catch (error) {
      lastError = error
      lastCandidate = { path: candidatePath, variant: candidate.variant }

      logZigBridgeLoadFailure(candidatePath, error)
    }
  }

  if (lastCandidate) {
    throw buildBridgeLoadError(lastCandidate.path, lastError, {
      variant: lastCandidate.variant,
      preference,
      override: false,
    })
  }

  throw new NativeBridgeError(
    'No Zig bridge library could be loaded. Rebuild it with "pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig".',
  )
}

const { module: nativeModule, path: libraryFile, variant: resolvedBridgeVariant } = loadBridgeLibrary()

export const bridgeVariant = resolvedBridgeVariant
export const isZigBridge = resolvedBridgeVariant === 'zig'
export const nativeLibraryPath = libraryFile

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
    temporal_bun_runtime_set_logger: {
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.int32,
    },
    temporal_bun_runtime_test_emit_log: {
      args: [
        FFIType.uint32_t,
        FFIType.ptr,
        FFIType.uint64_t,
        FFIType.ptr,
        FFIType.uint64_t,
        FFIType.uint64_t,
        FFIType.ptr,
        FFIType.uint64_t,
      ],
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
    temporal_bun_client_cancel_workflow: {
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
    temporal_bun_worker_new: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.ptr,
    },
    temporal_bun_worker_free: {
      args: [FFIType.ptr],
      returns: FFIType.int32_t,
    },
    temporal_bun_worker_poll_workflow_task: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    temporal_bun_worker_complete_workflow_task: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.int32_t,
    },
    temporal_bun_worker_complete_activity_task: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.int32_t,
    },
    temporal_bun_worker_poll_activity_task: {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    },
    temporal_bun_worker_record_activity_heartbeat: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.uint64_t],
      returns: FFIType.int32_t,
    },
    temporal_bun_worker_initiate_shutdown: {
      args: [FFIType.ptr],
      returns: FFIType.int32_t,
    },
    temporal_bun_worker_test_handle_new: {
      args: [],
      returns: FFIType.ptr,
    },
    temporal_bun_worker_test_handle_release: {
      args: [FFIType.ptr],
      returns: FFIType.void,
    },
  }
}

function ensureZigBridgePath(candidate: string): void {
  if (!/temporal[-_]bun[-_]bridge[-_]zig/.test(candidate)) {
    throw new Error(`Only Zig bridge libraries are supported. Invalid bridge candidate: ${candidate}`)
  }
}

function logZigBridgeLoadFailure(candidate: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  console.warn(`Failed to load Zig bridge at ${candidate}.\nReason: ${reason}`, error)
}

function buildBridgeLoadError(libraryPath: string, error: unknown, context: BridgeLoadErrorContext): Error {
  const reason = error instanceof Error ? error.message : String(error)
  const messages = [`Failed to load Temporal Bun bridge at ${libraryPath}`]
  if (reason) {
    messages.push(`Reason: ${reason}`)
  }

  if (context.override) {
    messages.push('Verify TEMPORAL_BUN_SDK_NATIVE_PATH or rebuild the specified library for this platform.')
  } else if (context.preference === 'enable') {
    messages.push(
      'TEMPORAL_BUN_SDK_USE_ZIG=1 expects a compiled Zig bridge. Rebuild it with "pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig".',
    )
  } else {
    messages.push(
      'Rebuild the Zig bridge or install packaged artefacts so a library exists under dist/native/<platform>/<arch>/ or bruke/zig-out/lib/.',
    )
  }

  const failure = new NativeBridgeError(messages.join('. '))
  ;(failure as Error & { cause?: unknown }).cause = error
  return failure
}

const {
  symbols: {
    temporal_bun_runtime_new,
    temporal_bun_runtime_free,
    temporal_bun_runtime_set_logger,
    temporal_bun_runtime_test_emit_log,
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
    temporal_bun_client_cancel_workflow,
    temporal_bun_client_signal_with_start,
    temporal_bun_client_query_workflow,
    temporal_bun_worker_new,
    temporal_bun_worker_free,
    temporal_bun_worker_poll_workflow_task,
    temporal_bun_worker_complete_workflow_task,
    temporal_bun_worker_complete_activity_task,
    temporal_bun_worker_poll_activity_task,
    temporal_bun_worker_record_activity_heartbeat,
    temporal_bun_worker_initiate_shutdown,
    temporal_bun_worker_test_handle_new,
    temporal_bun_worker_test_handle_release,
  },
} = nativeModule

const pendingByteArrayFfi = {
  poll: temporal_bun_pending_byte_array_poll,
  consume: temporal_bun_pending_byte_array_consume,
  free: temporal_bun_pending_byte_array_free,
}

const workerFfi = {
  pollActivityTask: temporal_bun_worker_poll_activity_task,
  pollWorkflowTask: temporal_bun_worker_poll_workflow_task,
  completeWorkflowTask: temporal_bun_worker_complete_workflow_task,
  completeActivityTask: temporal_bun_worker_complete_activity_task,
  recordActivityHeartbeat: temporal_bun_worker_record_activity_heartbeat,
  initiateShutdown: temporal_bun_worker_initiate_shutdown,
}

export const native = {
  bridgeVariant: resolvedBridgeVariant,

  createRuntime(options: Record<string, unknown> = {}): Runtime {
    const payload = Buffer.from(JSON.stringify(options), 'utf8')
    const handleNum = Number(temporal_bun_runtime_new(ptr(payload), payload.byteLength))
    if (!handleNum) {
      throw buildNativeBridgeError()
    }
    return { type: 'runtime', handle: handleNum as unknown as Pointer }
  },

  runtimeShutdown(runtime: Runtime): void {
    detachLoggerUnsafe(runtime)
    temporal_bun_runtime_free(runtime.handle)
  },

  async createClient(runtime: Runtime, config: Record<string, unknown>): Promise<NativeClient> {
    const payload = Buffer.from(JSON.stringify(config), 'utf8')
    const pendingHandle = Number(temporal_bun_client_connect_async(runtime.handle, ptr(payload), payload.byteLength))
    if (!pendingHandle) {
      throw buildNativeBridgeError()
    }
    try {
      const handleNum = await waitForClientHandle(pendingHandle)
      return { type: 'client', handle: handleNum as unknown as Pointer }
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
      return await waitForByteArray(pendingHandle, pendingByteArrayFfi)
    } finally {
      pendingByteArrayFfi.free(pendingHandle)
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

  installLogger(runtime: Runtime, callback: TemporalCoreLogger, onDetach?: () => void): void {
    if (typeof callback !== 'function') {
      throw new TypeError('Runtime logger callback must be a function')
    }

    const handleId = Number(runtime.handle)
    if (runtimeLoggerState.has(handleId)) {
      throw new NativeBridgeError('Temporal runtime logger already installed')
    }

    const jsCallback = new JSCallback(
      (level, targetPtr, targetLen, messagePtr, messageLen, timestampMillis, fieldsPtr, fieldsLen) => {
        const levelIndex = Number(level)
        const fieldsLength = Number(fieldsLen)
        const event: TemporalCoreLogEvent = {
          level: mapLogLevel(levelIndex),
          levelIndex,
          target: decodeUtf8(targetPtr, Number(targetLen)),
          message: decodeUtf8(messagePtr, Number(messageLen)),
          timestampMillis: Number(timestampMillis),
        }

        if (fieldsLength > 0) {
          const fieldsJson = decodeUtf8(fieldsPtr, fieldsLength)
          event.fieldsJson = fieldsJson
          event.fields = parseFields(fieldsJson)
        }

        callback(event)
      },
      {
        returns: 'void',
        args: ['u32', 'pointer', 'usize', 'pointer', 'usize', 'u64', 'pointer', 'usize'],
        threadsafe: true,
        onError(error) {
          detachLoggerUnsafe(runtime)
          throw error
        },
      },
    )

    const status = Number(temporal_bun_runtime_set_logger(runtime.handle, jsCallback.ptr))
    if (status !== 0) {
      jsCallback.close()
      throw buildNativeBridgeError()
    }

    runtimeLoggerState.set(handleId, { runtime, jsCallback, onDetach })
  },

  removeLogger(runtime: Runtime): void {
    detachLoggerOrThrow(runtime)
  },

  __TEST__: {
    emitSyntheticLog({
      level = 'info',
      target = '',
      message = '',
      timestampMillis = Date.now(),
      fieldsJson,
    }: {
      level?: TemporalCoreLogLevel | number
      target?: string
      message?: string
      timestampMillis?: number
      fieldsJson?: string
    } = {}): void {
      const levelIndex = typeof level === 'number' ? level : nativeLogLevels.indexOf(level ?? 'info')
      const normalizedLevel = levelIndex >= 0 ? levelIndex : nativeLogLevels.indexOf('info')

      const targetBuffer = Buffer.from(target ?? '', 'utf8')
      const messageBuffer = Buffer.from(message ?? '', 'utf8')
      const fieldsBuffer = fieldsJson ? Buffer.from(fieldsJson, 'utf8') : null

      temporal_bun_runtime_test_emit_log(
        normalizedLevel,
        pointerFromBuffer(targetBuffer),
        targetBuffer.length,
        pointerFromBuffer(messageBuffer),
        messageBuffer.length,
        BigInt(Math.trunc(timestampMillis ?? Date.now())),
        pointerFromBuffer(fieldsBuffer),
        fieldsBuffer?.length ?? 0,
      )
    },
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
      await waitForByteArray(pendingHandle, pendingByteArrayFfi)
    } finally {
      pendingByteArrayFfi.free(pendingHandle)
    }
  },

  async queryWorkflow(client: NativeClient, request: Record<string, unknown>): Promise<Uint8Array> {
    const payload = Buffer.from(JSON.stringify(request), 'utf8')
    const pendingHandle = Number(temporal_bun_client_query_workflow(client.handle, ptr(payload), payload.byteLength))
    if (!pendingHandle) {
      throw buildNativeBridgeError()
    }
    try {
      const rawBytes = await waitForByteArray(pendingHandle, pendingByteArrayFfi)
      if (isZigBridge) {
        return await decodeZigQueryWorkflowResponse(rawBytes)
      }
      return rawBytes
    } finally {
      pendingByteArrayFfi.free(pendingHandle)
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
      await waitForByteArray(pendingHandle, pendingByteArrayFfi)
    } finally {
      pendingByteArrayFfi.free(pendingHandle)
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
    const handleNum = Number(temporal_bun_worker_new(runtime.handle, client.handle, ptr(payload), payload.byteLength))
    if (!handleNum) {
      throw buildNativeBridgeError()
    }
    return { type: 'worker', handle: handleNum as unknown as Pointer }
  },

  destroyWorker(worker: NativeWorker): void {
    const status = Number(temporal_bun_worker_free(worker.handle))
    if (status === 0) {
      worker.handle = 0 as unknown as Pointer
      return
    }

    if (status === -1) {
      throw buildNativeBridgeError()
    }

    throw buildNativeBridgeError()
  },

  createWorkerHandleForTest(): NativeWorker {
    const handleNum = Number(temporal_bun_worker_test_handle_new())
    if (!handleNum) {
      throw buildNativeBridgeError()
    }
    return { type: 'worker', handle: handleNum as unknown as Pointer }
  },

  releaseWorkerHandleForTest(handle: Pointer): void {
    temporal_bun_worker_test_handle_release(handle)
  },

  workerCompleteWorkflowTask(worker: NativeWorker, payload: Uint8Array | Buffer): void {
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)

    const status = Number(workerFfi.completeWorkflowTask(worker.handle, ptr(buffer), buffer.byteLength))
    if (status !== 0) {
      throw buildNativeBridgeError()
    }
  },
  workerCompleteActivityTask(worker: NativeWorker, payload: Uint8Array | Buffer): void {
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)

    const status = Number(workerFfi.completeActivityTask(worker.handle, ptr(buffer), buffer.byteLength))
    if (status !== 0) {
      throw buildNativeBridgeError()
    }
  },
  workerRecordActivityHeartbeat(worker: NativeWorker, payload: Uint8Array | Buffer): void {
    const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    const status = Number(workerFfi.recordActivityHeartbeat(worker.handle, ptr(buffer), buffer.byteLength))
    if (status !== 0) {
      throw buildNativeBridgeError()
    }
  },

  worker: {
    async pollWorkflowTask(worker: NativeWorker): Promise<Uint8Array> {
      if (!isZigBridge) {
        throw new NativeBridgeError(
          'Workflow polling via native.worker.pollWorkflowTask requires the Zig bridge. Rebuild the native module with `TEMPORAL_BUN_SDK_USE_ZIG=1`.',
        )
      }

      const pendingHandle = Number(workerFfi.pollWorkflowTask(worker.handle))
      if (!pendingHandle) {
        throw buildNativeBridgeError()
      }

      try {
        return await waitForByteArray(pendingHandle, pendingByteArrayFfi)
      } finally {
        pendingByteArrayFfi.free(pendingHandle)
      }
    },

    completeWorkflowTask(worker: NativeWorker, payload: Uint8Array | Buffer): void {
      const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      const status = Number(workerFfi.completeWorkflowTask(worker.handle, ptr(buffer), buffer.byteLength))
      if (status !== 0) {
        throw buildNativeBridgeError()
      }
    },

    completeActivityTask(worker: NativeWorker, payload: Uint8Array | Buffer): void {
      const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      const status = Number(workerFfi.completeActivityTask(worker.handle, ptr(buffer), buffer.byteLength))
      if (status !== 0) {
        throw buildNativeBridgeError()
      }
    },

    recordActivityHeartbeat(worker: NativeWorker, payload: Uint8Array | Buffer): void {
      const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
      const status = Number(workerFfi.recordActivityHeartbeat(worker.handle, ptr(buffer), buffer.byteLength))
      if (status !== 0) {
        throw buildNativeBridgeError()
      }
    },

    initiateShutdown(worker: NativeWorker): void {
      const status = Number(workerFfi.initiateShutdown(worker.handle))
      if (status !== 0) {
        throw buildNativeBridgeError()
      }
    },

    async pollActivityTask(worker: NativeWorker): Promise<Uint8Array | null> {
      if (process.env.TEMPORAL_BUN_SDK_USE_ZIG !== '1' || !isZigBridge) {
        throw new NativeBridgeError({
          code: UNKNOWN_NATIVE_ERROR_CODE,
          message:
            'Activity polling via Zig requires TEMPORAL_BUN_SDK_USE_ZIG=1 and the Zig bridge. Rebuild the native bridge or enable the environment flag.',
          details: { bridgeVariant: resolvedBridgeVariant },
        })
      }

      const pendingHandle = Number(workerFfi.pollActivityTask(worker.handle))
      if (!pendingHandle) {
        throw buildNativeBridgeError()
      }

      try {
        const payload = await waitForByteArray(pendingHandle, pendingByteArrayFfi)
        return payload.byteLength === 0 ? null : payload
      } finally {
        pendingByteArrayFfi.free(pendingHandle)
      }
    },
  },
}

export const __testing = {
  pendingByteArrayFfi,
  workerFfi,
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

function resolveBridgeLibraryCandidates(preference: ZigPreference): BridgeResolution[] {
  const candidates: BridgeResolution[] = []
  const attemptedZigPaths: string[] = []

  const packaged = resolvePackagedZigBridgeLibraryPath()
  attemptedZigPaths.push(...packaged.attempted)
  if (packaged.path) {
    const zigPackagedPath = packaged.path
    candidates.push({ resolvePath: () => zigPackagedPath, variant: 'zig' })
  }

  const local = resolveLocalZigBridgeLibraryPath()
  attemptedZigPaths.push(...local.attempted)
  if (local.path) {
    const zigLocalPath = local.path
    candidates.push({ resolvePath: () => zigLocalPath, variant: 'zig' })
  }

  if (attemptedZigPaths.length > 0 && candidates.length === 0) {
    const message =
      preference === 'enable'
        ? 'TEMPORAL_BUN_SDK_USE_ZIG=1 was set but no Zig bridge artefacts were found.'
        : 'No Zig bridge binary was located for this platform.'
    logMissingZigBridge(
      attemptedZigPaths,
      `${message} Rebuild the bridge with "pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig".`,
    )
  }

  return candidates
}

async function decodeZigQueryWorkflowResponse(bytes: Uint8Array): Promise<Uint8Array> {
  const response = temporal.api.workflowservice.v1.QueryWorkflowResponse.decode(bytes)

  if (response.queryRejected) {
    throw new NativeBridgeError({
      code: 9,
      message: 'Temporal query was rejected',
      details: response.queryRejected,
      raw: JSON.stringify(response.queryRejected),
    })
  }

  if (!response.queryResult) {
    throw new NativeBridgeError({
      code: 13,
      message: 'Temporal query response missing query_result payloads',
      raw: 'missing query_result',
    })
  }

  const firstPayload = response.queryResult.payloads?.[0]
  let value: unknown = null
  if (firstPayload) {
    try {
      value = payloadConverter.fromPayload(firstPayload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new NativeBridgeError({
        code: 13,
        message: `Failed to decode queryWorkflow payload: ${message}`,
        details: error,
      })
    }
  }

  const jsonString = JSON.stringify(value ?? null)
  return Buffer.from(jsonString, 'utf8')
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

function logMissingZigBridge(paths: string[], message: string): void {
  if (paths.length === 0) {
    return
  }
  const uniquePaths = [...new Set(paths)]
  const details = uniquePaths.map((candidate) => `  • ${candidate}`).join('\n')
  console.warn(`${message}\nSearched the following locations:\n${details}`)
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
  // Wrap numeric addresses in a Pointer-compatible shape for bun:ffi
  const headerPtr = pointer as unknown as Pointer
  const header = new BigUint64Array(toArrayBuffer(headerPtr, 0, 24))
  const dataPtrNum = Number(header[0])
  const len = Number(header[1])
  const dataPtr = dataPtrNum as unknown as Pointer
  const view = new Uint8Array(toArrayBuffer(dataPtr, 0, len))
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

async function waitForByteArray(
  handle: number,
  ffi: typeof pendingByteArrayFfi = pendingByteArrayFfi,
): Promise<Uint8Array> {
  return await new Promise<Uint8Array>((resolve, reject) => {
    const poll = (): void => {
      const status = Number(ffi.poll(handle))
      if (status === 0) {
        setTimeout(poll, 0)
        return
      }

      if (status === 1) {
        try {
          const consumed = ffi.consume(handle)
          if (!consumed) {
            throw buildNativeBridgeError()
          }

          if (typeof consumed === 'number') {
            const arrayPtr = Number(consumed)
            if (!arrayPtr) {
              throw buildNativeBridgeError()
            }
            resolve(readByteArray(arrayPtr))
            return
          }

          if (consumed instanceof Uint8Array) {
            resolve(new Uint8Array(consumed))
            return
          }

          throw buildNativeBridgeError()
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
    const errPtrWrapped = errPtr as unknown as Pointer
    const buffer = Buffer.from(toArrayBuffer(errPtrWrapped, 0, len))
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
